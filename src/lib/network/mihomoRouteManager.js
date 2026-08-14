import { getProxyPoolById } from "@/models";
import { createMihomoClient, MIHOMO_ERROR_CODES, validateMihomoControllerUrl } from "./mihomoClient.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import { mihomoSelectorMutex } from "./keyedMutex.js";
import {
  getHealthyMihomoSnapshot,
  reserveHealthyMihomoEgress,
} from "./mihomoHealthPool.js";
import {
  getMihomoModelHealthState,
  isMihomoStableEgress,
  migrateMihomoState,
} from "./mihomoState.js";
import {
  createMihomoDebugContext,
  createMihomoDebugId,
  mihomoDebug,
  mihomoErrorFields,
} from "open-sse/utils/mihomoDebug.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

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
 * expected to await upstream response headers; streaming body consumption
 * happens after the callback returns and therefore does not hold the lease.
 */
export async function withMihomoSelectorLease({
  poolId,
  nodeName,
  route = {},
  getPool = getProxyPoolById,
  makeClient = createMihomoClient,
  priority = 0,
  signal = null,
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
  }, { priority, signal });
}

export function getMihomoSelectorMutexSize() {
  return mihomoSelectorMutex.size;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildMihomoEgressSnapshot({
  egress = null,
  identityKey = null,
  confidence = "unknown",
  observedAt = null,
  expiresAt = null,
  evidenceVersion = 0,
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
    evidenceVersion: Math.max(0, Math.floor(Number(egress?.evidenceVersion ?? evidenceVersion) || 0)),
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
  egressEvidenceVersion = 0,
  mappingVersion = 0,
  requestId = null,
  modelId = null,
  maxAttempts = null,
}) {
  const startedAtMs = Number.isFinite(Number(attemptStartedAtMs)) ? Number(attemptStartedAtMs) : Date.now();
  const routeEgressSnapshot = egressSnapshot && typeof egressSnapshot === "object" && !Array.isArray(egressSnapshot)
    ? egressSnapshot
    : null;
  const route = {
    proxyPoolId,
    modelId: text(modelId) || null,
    proxyProvider: proxyProvider || null,
    nodeName,
    nodeKey: `${proxyProvider || "__selector__"}\0${nodeName}`,
    region: region || "OTHER",
    selectorName,
    egressIdentityKey: identityKey || null,
    egressConfidence: egressConfidence || "unknown",
    egressSnapshot: buildMihomoEgressSnapshot({
      ...(routeEgressSnapshot || {}),
      identityKey: routeEgressSnapshot ? routeEgressSnapshot.identityKey : identityKey,
      confidence: routeEgressSnapshot?.confidence || egressConfidence,
      evidenceVersion: routeEgressSnapshot?.evidenceVersion ?? egressEvidenceVersion,
      startedAtMs,
      scopeEligible: routeEgressSnapshot?.scopeEligible === true,
    }),
    mappingVersion: Math.max(0, Math.floor(Number(mappingVersion) || 0)),
    attempt: Number.isFinite(attempt) ? attempt : 1,
    attemptStartedAtMs: startedAtMs,
    routeId: routeId || `${proxyPoolId}:${nodeName}:${Date.now()}`,
  };
  if (requestId) route.requestId = requestId;
  if (Number.isFinite(Number(maxAttempts))) route.maxAttempts = Number(maxAttempts);
  return route;
}

export function getMihomoEgressCandidateKey(node, nowMs = Date.now()) {
  if (isMihomoStableEgress(node?.egress, nowMs)) return node.egress.identityKey;
  return `node:${node?.key || `${node?.proxyProvider || "__selector__"}\0${node?.nodeName || ""}`}`;
}

export function groupMihomoNodesByEgress(nodes = [], nowMs = Date.now()) {
  const groups = new Map();
  for (const node of nodes) {
    const key = getMihomoEgressCandidateKey(node, nowMs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  for (const group of groups.values()) group.sort((left, right) => left.key.localeCompare(right.key));
  return groups;
}

function modelIdForRequest(modelId, businessProviderId) {
  return text(modelId) || text(businessProviderId);
}

function modelIsManaged(state, modelId) {
  return Array.isArray(state.maintenance?.selectedModels)
    && state.maintenance.selectedModels.includes(modelId);
}

function nodeTransportCooling(node, nowMs) {
  const cooldownUntil = finiteOrNull(node?.transportCooldownUntil);
  if (Number.isFinite(cooldownUntil)) return cooldownUntil > nowMs;
  return text(node?.transportStatus) === "cooling";
}

function nextMaintenanceAt(state, nowMs) {
  const next = finiteOrNull(state.maintenance?.nextRunAt);
  return Number.isFinite(next) && next > nowMs ? next : nowMs + 1000;
}

function earliestModelCooldown(state, modelId, nowMs) {
  let earliest = null;
  for (const identityKey of Object.keys(state.egressIdentities || {})) {
    const health = getMihomoModelHealthState({ mihomoState: state }, identityKey, modelId);
    const cooldownUntil = finiteOrNull(health.cooldownUntil);
    if (health.status !== "cooling" || !Number.isFinite(cooldownUntil) || cooldownUntil <= nowMs) continue;
    if (earliest === null || cooldownUntil < earliest) earliest = cooldownUntil;
  }
  return earliest;
}

function hasInventoryNodes(state) {
  return Object.values(state.proxyProviders || {}).some((provider) => Object.keys(provider?.nodes || {}).length > 0);
}

function makePoolStateError(code, message, { status, retryAfter = null, cause = null } = {}) {
  return new MihomoRouteError(code, message, {
    status,
    retryAfter: retryAfter ? new Date(retryAfter).toISOString() : null,
    cause,
  });
}

function mapReservationError(error, state, modelId, nowMs) {
  const code = error?.code || "MIHOMO_POOL_WARMING";
  if (code === "MIHOMO_POOL_SATURATED") {
    return makePoolStateError(code, "Mihomo healthy egress start capacity is saturated", {
      status: 503,
      retryAfter: nowMs + 1000,
      cause: error,
    });
  }
  if (code === "MIHOMO_POOL_EXHAUSTED") return error;
  if (code === "ABORT_ERR") return error;
  if (code === "MIHOMO_POOL_RATE_LIMITED") return error;
  const cooldown = earliestModelCooldown(state, modelId, nowMs);
  if (cooldown !== null) {
    return makePoolStateError("MIHOMO_POOL_RATE_LIMITED", "All healthy Mihomo egresses are cooling down", {
      status: 429,
      retryAfter: cooldown,
      cause: error,
    });
  }
  return makePoolStateError(code, error?.message || "Mihomo healthy pool is warming", {
    status: 503,
    retryAfter: nextMaintenanceAt(state, nowMs),
    cause: error,
  });
}

function noSnapshotError(state, modelId, nowMs) {
  const cooldown = earliestModelCooldown(state, modelId, nowMs);
  if (cooldown !== null) {
    return makePoolStateError("MIHOMO_POOL_RATE_LIMITED", "All healthy Mihomo egresses are cooling down", {
      status: 429,
      retryAfter: cooldown,
    });
  }
  if (!hasInventoryNodes(state) && Number(state.maintenance?.nodeCount) === 0) {
    return makePoolStateError("MIHOMO_NO_ELIGIBLE_NODES", "No eligible Mihomo leaf proxy nodes are available", {
      status: 503,
      retryAfter: nextMaintenanceAt(state, nowMs),
    });
  }
  return makePoolStateError("MIHOMO_POOL_WARMING", "Mihomo healthy pool is warming", {
    status: 503,
    retryAfter: nextMaintenanceAt(state, nowMs),
  });
}

/**
 * Select one egress from the immutable, model-specific Healthy Snapshot.
 * No Controller calls, directory discovery or request-time probe is allowed
 * on this path.
 */
export async function prepareMihomoRouteAttempt({
  poolId,
  modelId = null,
  businessProviderId = null,
  routeContext = {},
  getPool = getProxyPoolById,
  reserveEgress = reserveHealthyMihomoEgress,
  nowMs = Date.now(),
  signal = null,
} = {}) {
  const selectedModelId = modelIdForRequest(modelId, businessProviderId);
  if (!selectedModelId) throw new MihomoRouteError("MIHOMO_MODEL_NOT_MANAGED", "Mihomo model is required", { status: 503 });
  const { pool, config } = await loadManagedPool(poolId, getPool);
  const state = migrateMihomoState(pool.mihomoState);
  if (!modelIsManaged(state, selectedModelId)) {
    throw makePoolStateError("MIHOMO_MODEL_NOT_MANAGED", "The model is not managed by the Mihomo health pool", { status: 503 });
  }

  if (!(routeContext.attemptedEgressKeys instanceof Set)) routeContext.attemptedEgressKeys = new Set();
  if (!(routeContext.attemptedNodeKeysByEgress instanceof Map)) routeContext.attemptedNodeKeysByEgress = new Map();
  routeContext.modelId = selectedModelId;
  if (!routeContext.requestId) routeContext.requestId = createMihomoDebugId();
  if (!routeContext.routeId) routeContext.routeId = createMihomoDebugId();

  const snapshot = getHealthyMihomoSnapshot({ poolId, modelId: selectedModelId });
  if (!snapshot) throw noSnapshotError(state, selectedModelId, nowMs);
  if (snapshot.entries.length === 0) throw noSnapshotError(state, selectedModelId, nowMs);
  if (routeContext.maxAttempts === undefined) {
    routeContext.maxAttempts = Math.min(config.maxAttemptsPerRequest, snapshot.entries.length);
  }
  const effectiveMaxAttempts = Math.max(0, Number(routeContext.maxAttempts) || 0);
  const preferredEgressKey = text(routeContext.preferredEgressKey) || null;
  if (routeContext.attempts >= effectiveMaxAttempts && !preferredEgressKey) {
    return { route: null, snapshot, effectiveMaxAttempts, exhausted: true };
  }

  while (true) {
    let reservation;
    try {
      reservation = await reserveEgress({
        poolId,
        modelId: selectedModelId,
        attemptedEgressKeys: routeContext.attemptedEgressKeys,
        signal: signal || null,
        admissionWaitMs: config.admissionWaitMs,
        maxInFlightStartsPerEgress: config.maxInFlightStartsPerEgress,
        preferredEgressKey,
        nowMs,
      });
      routeContext.preferredEgressKey = null;
    } catch (error) {
      if (error?.code === "MIHOMO_POOL_EXHAUSTED") {
        return { route: null, snapshot, effectiveMaxAttempts, exhausted: true };
      }
      throw mapReservationError(error, state, selectedModelId, nowMs);
    }

    const entry = reservation.entry;
    const attemptedNodes = routeContext.attemptedNodeKeysByEgress.get(entry.identityKey) || new Set();
    const node = entry.nodes.find((candidate) => (
      !attemptedNodes.has(candidate.key) && !nodeTransportCooling(candidate, nowMs)
    ));
    if (!node) {
      reservation.release();
      routeContext.attemptedEgressKeys.add(entry.identityKey);
      continue;
    }

    attemptedNodes.add(node.key);
    routeContext.attemptedNodeKeysByEgress.set(entry.identityKey, attemptedNodes);
    routeContext.attempts = (Number(routeContext.attempts) || 0) + 1;
    const attemptStartedAtMs = nowMs;
    const route = buildMihomoRoute({
      proxyPoolId: poolId,
      modelId: selectedModelId,
      proxyProvider: node.proxyProvider,
      nodeName: node.nodeName,
      region: node.region,
      selectorName: config.selectorName,
      attempt: routeContext.attempts,
      requestId: routeContext.requestId,
      routeId: routeContext.routeId,
      maxAttempts: effectiveMaxAttempts,
      attemptStartedAtMs,
      egressIdentityKey: entry.identityKey,
      egressConfidence: "stable",
      egressEvidenceVersion: entry.evidenceVersion,
      mappingVersion: node.mappingVersion,
      egressSnapshot: {
        identityKey: entry.identityKey,
        confidence: "stable",
        expiresAt: entry.expiresAt,
        evidenceVersion: entry.evidenceVersion,
        scopeEligible: true,
      },
    });
    mihomoDebug("selected", createMihomoDebugContext(route), {
      modelId: selectedModelId,
      node: node.nodeName,
      egress: entry.identityKey,
      egressConfidence: "stable",
      egressFresh: true,
      evidenceVersion: entry.evidenceVersion,
    });
    return {
      route,
      entry,
      reservation,
      snapshot,
      effectiveMaxAttempts,
      exhausted: false,
    };
  }
}

export function clearMihomoRotationState() {
  // Kept as a no-op compatibility hook. Request routing no longer owns a
  // Region/candidate rotation cursor; fairness lives in the Health Snapshot.
}
