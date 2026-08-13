import { getProxyPoolById } from "@/models";
import { createMihomoClient, MIHOMO_ERROR_CODES, validateMihomoControllerUrl } from "./mihomoClient.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import { mihomoSelectorMutex } from "./keyedMutex.js";
import { discoverMihomoNodeDirectory, getMihomoNodeBusinessState } from "./mihomoState.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

const routeRotationState = new Map();

function selectorKey(controllerUrl, selectorName) {
  return `${validateMihomoControllerUrl(controllerUrl)}\0${selectorName}`;
}

export class MihomoRouteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
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

  return mihomoSelectorMutex.runExclusive(mutexKey, async () => {
    const client = makeClient({
      controllerUrl: config.controllerUrl,
      secret: config.controllerSecret,
      timeoutMs: config.controllerTimeoutMs,
    });

    try {
      await client.selectProxy(config.selectorName, nodeName);
      const selected = await client.getProxy(config.selectorName);
      verifySelector(selected, config.selectorName, nodeName);
    } catch (error) {
      if (error instanceof MihomoRouteError) throw error;
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
    };

    return callback(runtimeProxyOptions, publicRoute);
  });
}

export function getMihomoSelectorMutexSize() {
  return mihomoSelectorMutex.size;
}

export function buildMihomoRoute({ proxyPoolId, proxyProvider, nodeName, region, selectorName, attempt, routeId }) {
  return {
    proxyPoolId,
    proxyProvider: proxyProvider || null,
    nodeName,
    region: region || "OTHER",
    selectorName,
    attempt: Number.isFinite(attempt) ? attempt : 1,
    routeId: routeId || `${proxyPoolId}:${nodeName}:${Date.now()}`,
  };
}

function cooldownExpiry(pool, node, businessProviderId) {
  const state = getMihomoNodeBusinessState(pool, node, businessProviderId);
  const timestamp = Date.parse(state.cooldownUntil || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getRotationState(poolId, businessProviderId) {
  const key = `${poolId}\0${businessProviderId}`;
  let state = routeRotationState.get(key);
  if (!state) {
    state = { nodeCursorByRegion: new Map() };
    routeRotationState.set(key, state);
  }
  return state;
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

function earliestCooldownUntil(pool, nodes, businessProviderId, nowMs) {
  let earliest = null;
  for (const node of nodes) {
    const expiry = cooldownExpiry(pool, node, businessProviderId);
    if (expiry && expiry > nowMs && (earliest === null || expiry < earliest)) earliest = expiry;
  }
  return earliest ? new Date(earliest).toISOString() : null;
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
  nowMs = Date.now(),
} = {}) {
  if (!routeContext || !(routeContext.attemptedNodeKeys instanceof Set) || !(routeContext.deprioritizedRegions instanceof Set)) {
    throw new TypeError("routeContext must contain attemptedNodeKeys and deprioritizedRegions sets");
  }
  const { pool, config } = await loadManagedPool(poolId, getPool);
  const client = makeClient({
    controllerUrl: config.controllerUrl,
    secret: config.controllerSecret,
    timeoutMs: config.controllerTimeoutMs,
  });
  const directory = await discoverMihomoNodeDirectory({
    poolId,
    client,
    selectorName: config.selectorName,
    providerNames: config.providerNames,
    includeRegex: config.includeRegex,
    excludeRegex: config.excludeRegex,
    ttlMs: config.syncTtlMs,
    nowMs,
  });

  const availableNodes = directory.nodes.filter((node) => {
    if (routeContext.attemptedNodeKeys.has(node.key)) return false;
    const expiry = cooldownExpiry(pool, node, businessProviderId);
    return !expiry || expiry <= nowMs;
  });
  if (routeContext.maxAttempts === undefined) {
    routeContext.maxAttempts = Math.min(config.maxAttemptsPerRequest, availableNodes.length);
  }

  const effectiveMaxAttempts = routeContext.maxAttempts;
  if (routeContext.attempts >= effectiveMaxAttempts) {
    return {
      route: null,
      directory,
      effectiveMaxAttempts,
      earliestCooldown: earliestCooldownUntil(pool, directory.nodes, businessProviderId, nowMs),
    };
  }

  const candidate = chooseCandidate(availableNodes, config, routeContext, poolId, businessProviderId);
  if (!candidate) {
    return {
      route: null,
      directory,
      effectiveMaxAttempts,
      earliestCooldown: earliestCooldownUntil(pool, directory.nodes, businessProviderId, nowMs),
    };
  }

  routeContext.attempts += 1;
  routeContext.attemptedNodeKeys.add(candidate.key);
  return {
    route: buildMihomoRoute({
      proxyPoolId: poolId,
      proxyProvider: candidate.proxyProvider,
      nodeName: candidate.nodeName,
      region: candidate.region,
      selectorName: directory.selectorName || config.selectorName,
      attempt: routeContext.attempts,
    }),
    directory,
    effectiveMaxAttempts,
    earliestCooldown: earliestCooldownUntil(pool, directory.nodes, businessProviderId, nowMs),
  };
}

export function clearMihomoRotationState() {
  routeRotationState.clear();
}
