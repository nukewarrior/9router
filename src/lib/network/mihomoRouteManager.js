import { getProxyPoolById } from "@/models";
import { createMihomoClient, MIHOMO_ERROR_CODES, validateMihomoControllerUrl } from "./mihomoClient.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import { mihomoSelectorMutex } from "./keyedMutex.js";
import { enqueueMihomoEgressProbe, getMihomoEgressProbeReason } from "./mihomoEgressScheduler.js";
import {
  createMihomoDebugContext,
  createMihomoDebugId,
  mihomoDebug,
  mihomoErrorFields,
} from "open-sse/utils/mihomoDebug.js";
import {
  attachMihomoNodeEgress,
  discoverMihomoNodeDirectory,
  getMihomoEgressBusinessState,
  getMihomoNodeBusinessState,
  isMihomoStableEgress,
} from "./mihomoState.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

const routeRotationState = new Map();

function selectorKey(controllerUrl, selectorName) {
  return `${validateMihomoControllerUrl(controllerUrl)}\0${selectorName}`;
}

export class MihomoRouteError extends Error {
  constructor(code, message, details = {}) {
    super(message, details?.cause ? { cause: details.cause } : undefined);
    this.name = "MihomoRouteError";
    this.code = code;
    Object.assign(this, details);
  }
}

function invalidPool(message, details = {}) {
  return new MihomoRouteError("MIHOMO_INVALID_CONFIG", message, details);
}

async function loadManagedPool(poolId, getPool) {
  if (!poolId) throw invalidPool("Mihomo proxyPoolId is required");
  const pool = await getPool(poolId);
  if (!pool) throw invalidPool("Mihomo proxy pool was not found", { poolId });
  if (!isMihomoProxyPool(pool)) {
    throw invalidPool("Selected proxy pool is not a Mihomo managed pool", { poolId });
  }
  if (pool.isActive !== true) throw invalidPool("Mihomo proxy pool is inactive", { poolId });
  if (!text(pool.proxyUrl)) throw invalidPool("Mihomo proxy listener URL is missing", { poolId });

  let config;
  try {
    config = normalizeMihomoConfig(pool.mihomo || {});
  } catch (error) {
    throw invalidPool(error.message, { poolId, cause: error });
  }

  return { pool, config };
}

function verifySelector(selector, selectorName, nodeName) {
  const type = text(selector?.type).toLowerCase();
  if (type !== "selector") {
    throw new MihomoRouteError(
      MIHOMO_ERROR_CODES.SELECTOR_SWITCH_FAILED,
      `Mihomo proxy "${selectorName}" is not a Selector`,
      { selectorName, nodeName },
    );
  }
  if (text(selector?.now) !== nodeName) {
    throw new MihomoRouteError(
      MIHOMO_ERROR_CODES.SELECTOR_SWITCH_FAILED,
      `Mihomo Selector did not switch to "${nodeName}"`,
      { selectorName, nodeName, selectedNodeName: text(selector?.now) || null },
    );
  }
  return selector;
}

/**
 * Hold the per-Selector lease until the callback returns. The callback is
 * expected to await the upstream fetch headers; streaming body consumption
 * happens after handleChatCore returns and therefore does not hold the lease.
 */
export async function withMihomoSelectorLease({
  poolId,
  nodeName,
  route = {},
  getPool = getProxyPoolById,
  makeClient = createMihomoClient,
}, callback) {
  if (typeof callback !== "function") throw new TypeError("Mihomo selector lease callback is required");
  const { pool, config } = await loadManagedPool(poolId, getPool);
  const mutexKey = selectorKey(config.controllerUrl, config.selectorName);
  const debugContext = createMihomoDebugContext(route);

  return mihomoSelectorMutex.runExclusive(mutexKey, async () => {
    const client = makeClient({
      controllerUrl: config.controllerUrl,
      secret: config.controllerSecret,
      timeoutMs: config.controllerTimeoutMs,
    });

    const selectStartedAt = Date.now();
    mihomoDebug("controller.select.start", debugContext, {
      selector: config.selectorName,
      node: nodeName,
    });
    try {
      await client.selectProxy(config.selectorName, nodeName);
    } catch (error) {
      mihomoDebug("controller.select.failed", debugContext, {
        selector: config.selectorName,
        node: nodeName,
        elapsed: Date.now() - selectStartedAt,
        ...mihomoErrorFields(error),
      });
      throw error;
    }
    mihomoDebug("controller.select.ok", debugContext, {
      elapsed: Date.now() - selectStartedAt,
    });

    const verifyStartedAt = Date.now();
    try {
      const selected = await client.getProxy(config.selectorName);
      verifySelector(selected, config.selectorName, nodeName);
      mihomoDebug("controller.verify.ok", debugContext, {
        selected: text(selected?.now) || nodeName,
        elapsed: Date.now() - verifyStartedAt,
      });
    } catch (error) {
      mihomoDebug("controller.verify.failed", debugContext, {
        expected: nodeName,
        actual: text(error?.selectedNodeName) || "unknown",
        elapsed: Date.now() - verifyStartedAt,
        ...mihomoErrorFields(error),
      });
      throw error;
    }

    const publicRoute = {
      ...route,
      proxyPoolId: pool.id,
      nodeName,
      selectorName: config.selectorName,
    };
    delete publicRoute.controllerSecret;
    delete publicRoute.secret;

    const runtimeProxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: text(pool.proxyUrl),
      connectionNoProxy: "",
      strictProxy: true,
      ephemeralProxyDispatcher: true,
      mihomoManaged: true,
      connectionProxyPoolId: pool.id,
      mihomoDebugContext: debugContext,
    };

    return callback(runtimeProxyOptions, publicRoute);
  });
}

export function getMihomoSelectorMutexSize() {
  return mihomoSelectorMutex.size;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildMihomoEgressSnapshot({
  egress = null,
  identityKey = null,
  confidence = "unknown",
  observedAt = null,
  expiresAt = null,
  startedAtMs,
  scopeEligible = false,
} = {}) {
  const snapshotIdentityKey = text(egress?.identityKey) || text(identityKey) || null;
  return Object.freeze({
    startedAtMs,
    identityKey: snapshotIdentityKey,
    confidence: text(egress?.confidence) || text(confidence) || "unknown",
    observedAt: finiteOrNull(egress?.observedAt ?? observedAt),
    expiresAt: finiteOrNull(egress?.expiresAt ?? expiresAt),
    scopeEligible: scopeEligible === true && Boolean(snapshotIdentityKey),
  });
}

export function buildMihomoRoute({
  proxyPoolId,
  proxyProvider,
  nodeName,
  region,
  selectorName,
  attempt,
  attemptStartedAtMs = Date.now(),
  routeId,
  egressIdentityKey: identityKey = null,
  egressConfidence = "unknown",
  egressSnapshot = null,
  requestId = null,
  maxAttempts = null,
}) {
  const startedAtMs = Number.isFinite(Number(attemptStartedAtMs)) ? Number(attemptStartedAtMs) : Date.now();
  const routeEgressSnapshot = egressSnapshot && typeof egressSnapshot === "object" && !Array.isArray(egressSnapshot)
    ? egressSnapshot
    : null;
  const route = {
    proxyPoolId,
    proxyProvider: proxyProvider || null,
    nodeName,
    region: region || "OTHER",
    selectorName,
    egressIdentityKey: identityKey || null,
    egressConfidence: egressConfidence || "unknown",
    egressSnapshot: buildMihomoEgressSnapshot({
      ...(routeEgressSnapshot || {}),
      identityKey: routeEgressSnapshot ? routeEgressSnapshot.identityKey : identityKey,
      confidence: routeEgressSnapshot?.confidence || egressConfidence,
      startedAtMs,
      scopeEligible: routeEgressSnapshot?.scopeEligible === true,
    }),
    attempt: Number.isFinite(attempt) ? attempt : 1,
    attemptStartedAtMs: startedAtMs,
    routeId: routeId || `${proxyPoolId}:${nodeName}:${Date.now()}`,
  };
  if (requestId) route.requestId = requestId;
  if (Number.isFinite(Number(maxAttempts))) route.maxAttempts = Number(maxAttempts);
  return route;
}

function parseCooldownUntil(state) {
  const timestamp = Date.parse(state?.cooldownUntil || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cooldownExpiries(pool, node, businessProviderId, config, nowMs) {
  const expiries = [];
  const nodeExpiry = parseCooldownUntil(getMihomoNodeBusinessState(pool, node, businessProviderId));
  if (nodeExpiry !== null) expiries.push(nodeExpiry);
  if (config?.egressScopedCooldown === true && isMihomoStableEgress(node.egress, nowMs)) {
    const egressState = getMihomoEgressBusinessState(pool, node.egress.identityKey, businessProviderId);
    const egressExpiry = parseCooldownUntil(egressState);
    if (egressExpiry !== null) expiries.push(egressExpiry);
  }
  return expiries;
}

function isMihomoRouteCooling(pool, node, businessProviderId, config, nowMs) {
  return cooldownExpiries(pool, node, businessProviderId, config, nowMs).some((expiry) => expiry > nowMs);
}

function getRotationState(poolId, businessProviderId) {
  const key = `${poolId}\0${businessProviderId}`;
  let state = routeRotationState.get(key);
  if (!state) {
    state = {
      nodeCursorByRegion: new Map(),
      egressCursorByRegion: new Map(),
      nodeCursorByEgress: new Map(),
      shadowEgressCursorByRegion: new Map(),
      shadowNodeCursorByEgress: new Map(),
    };
    routeRotationState.set(key, state);
  }
  return state;
}

export function getMihomoEgressCandidateKey(node, nowMs = Date.now()) {
  if (isMihomoStableEgress(node?.egress, nowMs)) {
    return node.egress.identityKey;
  }
  return `node:${node?.key || `${node?.proxyProvider || "__selector__"}\0${node?.nodeName || ""}`}`;
}

export function groupMihomoNodesByEgress(nodes = [], nowMs = Date.now()) {
  const groups = new Map();
  for (const node of nodes) {
    const key = getMihomoEgressCandidateKey(node, nowMs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  for (const group of groups.values()) group.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

function chooseCandidate(nodes, config, routeContext, poolId, businessProviderId) {
  const preferred = nodes.filter((node) => !routeContext.deprioritizedRegions.has(node.region));
  const pool = preferred.length > 0 ? preferred : nodes;
  if (pool.length === 0) return null;

  const order = new Map((config.regionOrder || []).map((region, index) => [region, index]));
  const grouped = new Map();
  for (const node of pool) {
    if (!grouped.has(node.region)) grouped.set(node.region, []);
    grouped.get(node.region).push(node);
  }
  const regions = [...grouped.keys()].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
  const rotation = getRotationState(poolId, businessProviderId);
  // regionOrder is a priority list: a fresh request stays in the first
  // eligible region. The process-local cursor only balances nodes within it.
  const region = regions[0];
  const regionNodes = grouped.get(region).sort((a, b) => a.key.localeCompare(b.key));
  const cursor = rotation.nodeCursorByRegion.get(region) || 0;
  const selected = regionNodes[cursor % regionNodes.length];
  rotation.nodeCursorByRegion.set(region, cursor + 1);
  return selected;
}

function chooseEgressCandidate(nodes, config, routeContext, poolId, businessProviderId, nowMs, { shadow = false } = {}) {
  const preferred = nodes.filter((node) => !routeContext.deprioritizedRegions.has(node.region));
  const pool = preferred.length > 0 ? preferred : nodes;
  if (pool.length === 0) return null;

  const order = new Map((config.regionOrder || []).map((region, index) => [region, index]));
  const byRegion = new Map();
  for (const node of pool) {
    if (!byRegion.has(node.region)) byRegion.set(node.region, []);
    byRegion.get(node.region).push(node);
  }
  const regions = [...byRegion.keys()].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
  const rotation = getRotationState(poolId, businessProviderId);
  const region = regions[0];
  const groups = groupMihomoNodesByEgress(byRegion.get(region), nowMs);
  const groupKeys = [...groups.keys()].sort();
  if (groupKeys.length === 0) return null;

  const regionCursor = shadow
    ? (rotation.shadowEgressCursorByRegion.get(region) || 0)
    : (rotation.egressCursorByRegion.get(region) || 0);
  const groupKey = groupKeys[regionCursor % groupKeys.length];
  const nextRegionCursor = regionCursor + 1;
  if (shadow) rotation.shadowEgressCursorByRegion.set(region, nextRegionCursor);
  else rotation.egressCursorByRegion.set(region, nextRegionCursor);

  const group = groups.get(groupKey);
  const nodeCursorKey = `${region}\0${groupKey}`;
  const nodeCursorMap = shadow ? rotation.shadowNodeCursorByEgress : rotation.nodeCursorByEgress;
  const nodeCursor = nodeCursorMap.get(nodeCursorKey) || 0;
  const selected = group[nodeCursor % group.length];
  nodeCursorMap.set(nodeCursorKey, nodeCursor + 1);
  return { node: selected, egressKey: groupKey };
}

function earliestCooldownUntil(pool, nodes, businessProviderId, config, nowMs) {
  let earliest = null;
  for (const node of nodes) {
    for (const expiry of cooldownExpiries(pool, node, businessProviderId, config, nowMs)) {
      if (expiry > nowMs && (earliest === null || expiry < earliest)) earliest = expiry;
    }
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

function buildCandidateDebugStats(pool, directory, availableNodes, businessProviderId, config, nowMs) {
  const stableEgresses = new Set();
  const coolingEgresses = new Set();
  let coolingNodes = 0;
  let unknownEgress = 0;

  for (const node of directory.nodes) {
    try {
      if (parseCooldownUntil(getMihomoNodeBusinessState(pool, node, businessProviderId)) > nowMs) coolingNodes += 1;
    } catch {
      // Diagnostics must never make an otherwise valid route unavailable.
    }
    if (!isMihomoStableEgress(node.egress, nowMs)) {
      unknownEgress += 1;
      continue;
    }
    stableEgresses.add(node.egress.identityKey);
    if (config.egressScopedCooldown === true) {
      try {
        if (parseCooldownUntil(getMihomoEgressBusinessState(pool, node.egress.identityKey, businessProviderId)) > nowMs) {
          coolingEgresses.add(node.egress.identityKey);
        }
      } catch {
        // Diagnostics must never make an otherwise valid route unavailable.
      }
    }
  }

  return {
    total: directory.nodes.length,
    eligible: availableNodes.length,
    coolingNodes,
    coolingEgress: coolingEgresses.size,
    distinctEgress: stableEgresses.size,
    unknownEgress,
    regionOrder: (config.regionOrder || []).join(",") || "none",
    providerFilter: config.providerNames?.length > 0 ? "enabled" : "disabled",
    includeRegex: config.includeRegex ? "enabled" : "disabled",
    excludeRegex: config.excludeRegex ? "enabled" : "disabled",
  };
}

/**
 * Discover and choose one node for a request. The routeContext is deliberately
 * request-scoped; only the fairness cursor lives in process memory.
 */
export async function prepareMihomoRouteAttempt({
  poolId,
  businessProviderId,
  routeContext,
  getPool = getProxyPoolById,
  makeClient = createMihomoClient,
  enqueueProbe = null,
  nowMs = Date.now(),
} = {}) {
  if (!routeContext || !(routeContext.attemptedNodeKeys instanceof Set) || !(routeContext.deprioritizedRegions instanceof Set)) {
    throw new TypeError("routeContext must contain attemptedNodeKeys and deprioritizedRegions sets");
  }
  if (!(routeContext.attemptedEgressKeys instanceof Set)) routeContext.attemptedEgressKeys = new Set();
  if (!routeContext.requestId) routeContext.requestId = createMihomoDebugId();
  if (!routeContext.routeId) routeContext.routeId = createMihomoDebugId();
  const { pool, config } = await loadManagedPool(poolId, getPool);
  const prepareDebugContext = createMihomoDebugContext({
    requestId: routeContext.requestId,
    routeId: routeContext.routeId,
  });
  mihomoDebug("prepare", prepareDebugContext, {
    pool: poolId,
    selector: config.selectorName,
    maxAttempts: config.maxAttemptsPerRequest,
    businessProvider: businessProviderId,
    providerFilter: config.providerNames?.length > 0 ? "enabled" : "disabled",
    includeRegex: config.includeRegex ? "enabled" : "disabled",
    excludeRegex: config.excludeRegex ? "enabled" : "disabled",
  });
  const client = makeClient({
    controllerUrl: config.controllerUrl,
    secret: config.controllerSecret,
    timeoutMs: config.controllerTimeoutMs,
  });
  const directory = attachMihomoNodeEgress(await discoverMihomoNodeDirectory({
    poolId,
    client,
    selectorName: config.selectorName,
    providerNames: config.providerNames,
    includeRegex: config.includeRegex,
    excludeRegex: config.excludeRegex,
    mihomoState: pool.mihomoState,
    ttlMs: config.syncTtlMs,
    nowMs,
  }), pool);

  // Mapping maintenance is deliberately fire-and-forget. The request keeps
  // using the safe node-scoped fallback while a single background worker
  // refreshes unknown/stale/expiring nodes through the same Selector lease.
  const queueProbe = enqueueProbe || (getPool === getProxyPoolById ? enqueueMihomoEgressProbe : null);
  if (queueProbe) {
    for (const node of directory.nodes) {
      const reason = getMihomoEgressProbeReason(node.egress, {
        nowMs,
        ttlMs: config.egressProbeTtlMs,
      });
      if (!reason) continue;
      try {
        const queued = queueProbe({
          poolId,
          proxyProvider: node.proxyProvider,
          nodeName: node.nodeName,
          egress: node.egress,
          reason,
          ttlMs: config.egressProbeTtlMs,
          getPool,
          makeClient,
        });
        if (queued && typeof queued.then === "function") void queued.catch(() => {});
      } catch {
        // Queue maintenance must never turn a healthy route preparation into
        // a user-visible failure.
      }
    }
  }

  const availableNodes = directory.nodes.filter((node) => {
    if (routeContext.attemptedNodeKeys.has(node.key)) return false;
    return !isMihomoRouteCooling(pool, node, businessProviderId, config, nowMs);
  });
  const availableEgressNodes = config.preferDistinctEgress
    ? availableNodes.filter((node) => !routeContext.attemptedEgressKeys.has(getMihomoEgressCandidateKey(node, nowMs)))
    : availableNodes;
  const availableCandidateCount = config.preferDistinctEgress
    ? new Set(availableEgressNodes.map((node) => getMihomoEgressCandidateKey(node, nowMs))).size
    : availableNodes.length;
  if (routeContext.maxAttempts === undefined) {
    routeContext.maxAttempts = Math.min(config.maxAttemptsPerRequest, availableCandidateCount);
  }

  const effectiveMaxAttempts = routeContext.maxAttempts;
  mihomoDebug("candidates", {
    ...prepareDebugContext,
    maxAttempts: effectiveMaxAttempts,
  }, buildCandidateDebugStats(pool, directory, availableNodes, businessProviderId, config, nowMs));
  if (routeContext.attempts >= effectiveMaxAttempts) {
    return {
      route: null,
      directory,
      effectiveMaxAttempts,
      earliestCooldown: earliestCooldownUntil(pool, directory.nodes, businessProviderId, config, nowMs),
    };
  }

  const shadowCandidate = !config.preferDistinctEgress
    ? chooseEgressCandidate(availableNodes, config, routeContext, poolId, businessProviderId, nowMs, { shadow: true })
    : null;
  const selectedCandidate = config.preferDistinctEgress
    ? chooseEgressCandidate(availableEgressNodes, config, routeContext, poolId, businessProviderId, nowMs)
    : { node: chooseCandidate(availableNodes, config, routeContext, poolId, businessProviderId), egressKey: null };
  const candidate = selectedCandidate?.node;
  if (!candidate) {
    return {
      route: null,
      directory,
      effectiveMaxAttempts,
      earliestCooldown: earliestCooldownUntil(pool, directory.nodes, businessProviderId, config, nowMs),
    };
  }

  routeContext.attempts += 1;
  routeContext.attemptedNodeKeys.add(candidate.key);
  const candidateEgressKey = selectedCandidate.egressKey || getMihomoEgressCandidateKey(candidate, nowMs);
  if (config.preferDistinctEgress) routeContext.attemptedEgressKeys.add(candidateEgressKey);
  const selectedNodeState = getMihomoNodeBusinessState(pool, candidate, businessProviderId);
  const selectedEgressState = isMihomoStableEgress(candidate.egress, nowMs)
    ? getMihomoEgressBusinessState(pool, candidate.egress.identityKey, businessProviderId)
    : null;
  const attemptDebugContext = createMihomoDebugContext({
    requestId: routeContext.requestId,
    routeId: routeContext.routeId,
    attempt: routeContext.attempts,
    maxAttempts: effectiveMaxAttempts,
  });
  mihomoDebug("selected", attemptDebugContext, {
    node: candidate.nodeName,
    region: candidate.region,
    egress: candidate.egress?.identityKey || "unknown",
    egressConfidence: candidate.egress?.confidence || "unknown",
    egressFresh: isMihomoStableEgress(candidate.egress, nowMs),
    nodeCooldownUntil: selectedNodeState.cooldownUntil || null,
    egressCooldownUntil: selectedEgressState?.cooldownUntil || null,
  });
  const shadowRoute = shadowCandidate?.node
    ? buildMihomoRoute({
      proxyPoolId: poolId,
      proxyProvider: shadowCandidate.node.proxyProvider,
      nodeName: shadowCandidate.node.nodeName,
      region: shadowCandidate.node.region,
      selectorName: directory.selectorName || config.selectorName,
      attempt: routeContext.attempts,
      requestId: routeContext.requestId,
      routeId: routeContext.routeId,
      maxAttempts: effectiveMaxAttempts,
      attemptStartedAtMs: nowMs,
      egressIdentityKey: shadowCandidate.egressKey,
      egressConfidence: shadowCandidate.node.egress?.confidence,
      egressSnapshot: buildMihomoEgressSnapshot({
        egress: shadowCandidate.node.egress,
        startedAtMs: nowMs,
        scopeEligible: config.egressScopedCooldown === true && isMihomoStableEgress(shadowCandidate.node.egress, nowMs),
      }),
    })
    : null;
  return {
    route: buildMihomoRoute({
      proxyPoolId: poolId,
      proxyProvider: candidate.proxyProvider,
      nodeName: candidate.nodeName,
      region: candidate.region,
      selectorName: directory.selectorName || config.selectorName,
      attempt: routeContext.attempts,
      requestId: routeContext.requestId,
      routeId: routeContext.routeId,
      maxAttempts: effectiveMaxAttempts,
      attemptStartedAtMs: nowMs,
      egressIdentityKey: candidateEgressKey,
      egressConfidence: candidate.egress?.confidence,
      egressSnapshot: buildMihomoEgressSnapshot({
        egress: candidate.egress,
        startedAtMs: nowMs,
        scopeEligible: config.egressScopedCooldown === true && isMihomoStableEgress(candidate.egress, nowMs),
      }),
    }),
    shadowRoute,
    directory,
    effectiveMaxAttempts,
    earliestCooldown: earliestCooldownUntil(pool, directory.nodes, businessProviderId, config, nowMs),
  };
}

export function clearMihomoRotationState() {
  routeRotationState.clear();
}
