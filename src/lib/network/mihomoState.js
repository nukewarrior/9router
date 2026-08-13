import { getProxyPoolById as defaultGetProxyPoolById, mutateProxyPool as defaultMutateProxyPool } from "@/models";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { classifyRateLimitError, isIpCandidateRateLimitError } from "open-sse/services/errorClassification.js";

const NESTED_PROXY_TYPES = new Set([
  "selector",
  "urltest",
  "fallback",
  "loadbalance",
  "load-balance",
  "direct",
  "reject",
  "dns",
  "pass",
]);

const nodeDirectoryCache = new Map();

export const SELECTOR_PROXY_PROVIDER = "__selector__";

export const MIHOMO_EGRESS_CONFIDENCES = Object.freeze([
  "stable",
  "tentative",
  "dynamic",
  "unknown",
]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function clone(value) {
  if (typeof structuredClone === "function") {
    try { return structuredClone(value); } catch { /* use JSON fallback */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function metadataNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : item?.name).map(text).filter(Boolean);
}

/**
 * Normalize the Controller's GET /proxies envelope while keeping the flat
 * object shape useful for small fakes and older callers.
 */
function normalizeProxyMap(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  if (payload.proxies && typeof payload.proxies === "object" && !Array.isArray(payload.proxies)) {
    return payload.proxies;
  }
  return payload;
}

function metadataDelayMs(metadata) {
  const direct = Number(metadata?.delayMs ?? metadata?.delay);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const history = Array.isArray(metadata?.history) ? metadata.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const delay = Number(history[index]?.delayMs ?? history[index]?.delay);
    if (Number.isFinite(delay) && delay >= 0) return delay;
  }
  return null;
}

function metadataAlive(metadata) {
  if (metadata?.alive === false) return false;
  if (metadata?.alive === true) return true;
  return null;
}

function isLeafProxy(metadata) {
  const type = text(metadata?.type).toLowerCase().replace(/\s+/g, "");
  return !NESTED_PROXY_TYPES.has(type);
}

function compileFilter(pattern, fieldName) {
  if (!pattern) return null;
  try {
    const inlineFlags = pattern.match(/^\(\?([imsu]+)\)/i);
    return new RegExp(inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern, inlineFlags?.[1] || "");
  } catch {
    const error = new Error(`${fieldName} is invalid`);
    error.code = "MIHOMO_INVALID_CONFIG";
    throw error;
  }
}

/**
 * Classify a node name without using overly broad single-character matches.
 */
export function classifyNodeRegion(nodeName) {
  const name = text(nodeName).toLowerCase();
  const patterns = [
    ["TW", /🇹🇼|台湾|taiwan|\btw\b/iu],
    ["JP", /🇯🇵|日本|japan|\bjp\b/iu],
    ["US", /🇺🇸|美国|usa|united\s+states|\bus\b/iu],
    ["SG", /🇸🇬|新加坡|singapore|\bsg\b/iu],
    ["HK", /🇭🇰|香港|hong\s+kong|\bhk\b/iu],
    ["KR", /🇰🇷|韩国|korea|\bkr\b/iu],
  ];
  return patterns.find(([, pattern]) => pattern.test(name))?.[0] || "OTHER";
}

function buildProviderNameByNode(providerDataByName, configuredProviderNames) {
  const namesByNode = new Map();
  for (const providerName of configuredProviderNames) {
    const providerData = providerDataByName?.[providerName] || {};
    for (const nodeName of metadataNames(providerData.proxies || providerData.all)) {
      if (!namesByNode.has(nodeName)) namesByNode.set(nodeName, providerName);
    }
  }
  return namesByNode;
}

function normalizeSelector(selector) {
  if (!selector || typeof selector !== "object" || text(selector.type).toLowerCase() !== "selector") {
    const error = new Error("Configured Mihomo proxy is not a Selector");
    error.code = "MIHOMO_SELECTOR_NOT_FOUND";
    throw error;
  }
  return selector;
}

/**
 * Build a leaf-node directory from the Controller's current Selector and
 * proxy metadata. Mihomo remains the source of truth; this result is a TTL
 * cache only and is safe to discard on restart.
 */
export function buildMihomoNodeDirectory({ selector, selectorName = null, proxies, providerDataByName = {}, providerNames = [], includeRegex = "", excludeRegex = "", mihomoState = null } = {}) {
  const normalizedSelector = normalizeSelector(selector);
  const selectorNames = metadataNames(normalizedSelector.all);
  const proxyMap = normalizeProxyMap(proxies);
  const providerNameByNode = buildProviderNameByNode(providerDataByName, providerNames);
  const include = compileFilter(includeRegex, "includeRegex");
  const exclude = compileFilter(excludeRegex, "excludeRegex");
  const warnings = [];
  const nodes = [];

  for (const nodeName of selectorNames) {
    if (include && !include.test(nodeName)) continue;
    if (exclude && exclude.test(nodeName)) continue;

    if (providerNames.length > 0 && !providerNameByNode.has(nodeName)) continue;

    const metadata = proxyMap[nodeName] || {};
    if (!isLeafProxy(metadata)) {
      warnings.push(`Excluded nested proxy group "${nodeName}": type=${text(metadata.type) || "unknown"}`);
      continue;
    }
    if (metadataAlive(metadata) === false) continue;

    const proxyProvider = providerNameByNode.get(nodeName) || SELECTOR_PROXY_PROVIDER;
    const persistedEgress = mihomoState?.proxyProviders?.[proxyProvider]?.nodes?.[nodeName]?.egress;
    nodes.push({
      key: `${proxyProvider}\0${nodeName}`,
      nodeName,
      proxyProvider,
      region: classifyNodeRegion(nodeName),
      type: text(metadata.type) || null,
      alive: metadataAlive(metadata),
      delayMs: metadataDelayMs(metadata),
      history: Array.isArray(metadata.history) ? clone(metadata.history) : [],
      egress: persistedEgress && typeof persistedEgress === "object" ? clone(persistedEgress) : null,
    });
  }

  return {
    selectorName: selectorName || normalizedSelector.name || null,
    selectorNow: text(normalizedSelector.now) || null,
    nodes,
    warnings,
  };
}

export async function discoverMihomoNodeDirectory({ poolId, client, selectorName, providerNames = [], includeRegex = "", excludeRegex = "", mihomoState = null, ttlMs = 30000, nowMs = Date.now() } = {}) {
  if (!poolId) throw new TypeError("poolId is required for Mihomo node discovery");
  if (!client) throw new TypeError("Mihomo client is required for node discovery");
  const cached = nodeDirectoryCache.get(poolId);
  if (cached && cached.expiresAt > nowMs) {
    const cachedValue = clone(cached.value);
    if (mihomoState) {
      return {
        ...cachedValue,
        nodes: cachedValue.nodes.map((node) => ({
          ...node,
          egress: mihomoState?.proxyProviders?.[node.proxyProvider]?.nodes?.[node.nodeName]?.egress
            ? clone(mihomoState.proxyProviders[node.proxyProvider].nodes[node.nodeName].egress)
            : null,
        })),
      };
    }
    return cachedValue;
  }

  const selector = await client.getProxy(selectorName);
  const proxies = await client.getProxies();
  const providerDataByName = {};
  for (const providerName of providerNames) {
    providerDataByName[providerName] = await client.getProxyProvider(providerName);
  }

  const value = buildMihomoNodeDirectory({
    selector,
    selectorName,
    proxies,
    providerDataByName,
    providerNames,
    includeRegex,
    excludeRegex,
    mihomoState,
  });
  nodeDirectoryCache.set(poolId, {
    value: clone(value),
    expiresAt: nowMs + Math.max(1000, Number(ttlMs) || 30000),
  });
  return clone(value);
}

export function clearMihomoNodeDirectoryCache(poolId = null) {
  if (poolId) nodeDirectoryCache.delete(poolId);
  else nodeDirectoryCache.clear();
}

const RESERVED_STATE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stateKey(value, fieldName) {
  const key = text(value);
  if (!key || RESERVED_STATE_KEYS.has(key)) {
    const error = new Error(`${fieldName} is required and must be a safe state key`);
    error.code = "MIHOMO_INVALID_STATE_KEY";
    throw error;
  }
  return key;
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) parent[key] = {};
  return parent[key];
}

function emptyBusinessState() {
  return {
    cooldownUntil: null,
    backoffLevel: 0,
    lastStatus: null,
    lastErrorType: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
  };
}

function normalizeEgressRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const confidence = MIHOMO_EGRESS_CONFIDENCES.includes(value.confidence) ? value.confidence : "unknown";
  const observedIps = Array.isArray(value.observedIps)
    ? [...new Set(value.observedIps.map(text).filter(Boolean))].slice(0, 5)
    : [];
  return {
    ip: text(value.ip) || null,
    family: Number(value.family) === 4 || Number(value.family) === 6 ? Number(value.family) : null,
    identityKey: text(value.identityKey) || null,
    confidence,
    observedIps,
    sampleCount: Math.max(0, Number(value.sampleCount) || 0),
    successfulSamples: Math.max(0, Number(value.successfulSamples) || 0),
    observedAt: Number.isFinite(Number(value.observedAt)) ? Number(value.observedAt) : null,
    expiresAt: Number.isFinite(Number(value.expiresAt)) ? Number(value.expiresAt) : null,
    lastProbeAt: Number.isFinite(Number(value.lastProbeAt)) ? Number(value.lastProbeAt) : null,
    lastProbeError: text(value.lastProbeError) || null,
    needsProbe: value.needsProbe === true,
  };
}

export function getMihomoNodeEgress(pool, route) {
  const proxyProvider = stateKey(route?.proxyProvider || SELECTOR_PROXY_PROVIDER, "proxyProvider");
  const nodeName = stateKey(route?.nodeName, "nodeName");
  return normalizeEgressRecord(pool?.mihomoState?.proxyProviders?.[proxyProvider]?.nodes?.[nodeName]?.egress);
}

export function isMihomoEgressFresh(egress, nowMs = Date.now()) {
  const expiresAt = Number(egress?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt >= nowMs;
}

export function isMihomoStableEgress(egress, nowMs = Date.now()) {
  const family = Number(egress?.family);
  const identityKey = text(egress?.identityKey);
  return Boolean(
    egress?.confidence === "stable"
    && (family === 4 || family === 6)
    && text(egress?.ip)
    && identityKey.startsWith(`${family}:`)
    && isMihomoEgressFresh(egress, nowMs),
  );
}

export function getMihomoEgressBusinessState(pool, identityKey, businessProviderId) {
  const identity = stateKey(identityKey, "identityKey");
  const businessProvider = stateKey(businessProviderId, "businessProvider");
  return pool?.mihomoState?.egressIdentities?.[identity]?.business?.[businessProvider] || emptyBusinessState();
}

export function attachMihomoNodeEgress(directory, pool) {
  if (!directory || typeof directory !== "object") return directory;
  return {
    ...directory,
    nodes: Array.isArray(directory.nodes)
      ? directory.nodes.map((node) => ({ ...node, egress: getMihomoNodeEgress(pool, node) }))
      : [],
  };
}

export function getMihomoNodeBusinessState(pool, route, businessProviderId) {
  const proxyProvider = stateKey(route?.proxyProvider || SELECTOR_PROXY_PROVIDER, "proxyProvider");
  const nodeName = stateKey(route?.nodeName, "nodeName");
  const businessProvider = stateKey(businessProviderId, "businessProvider");
  return pool?.mihomoState?.proxyProviders?.[proxyProvider]?.nodes?.[nodeName]?.business?.[businessProvider] || emptyBusinessState();
}

function getCooldownMs(config, previousState, resetsAtMs, nowMs) {
  const reset = Number(resetsAtMs);
  if (Number.isFinite(reset) && reset > nowMs) return Math.min(reset - nowMs, config.cooldown.maxMs);
  const previousLevel = Math.max(0, Number(previousState?.backoffLevel) || 0);
  return Math.min(
    config.cooldown.baseMs * Math.pow(config.cooldown.multiplier, previousLevel),
    config.cooldown.maxMs,
  );
}

function normalizeStateContainer(pool) {
  if (!pool.mihomoState || typeof pool.mihomoState !== "object" || Array.isArray(pool.mihomoState)) {
    pool.mihomoState = { proxyProviders: {}, egressIdentities: {} };
  }
  if (!pool.mihomoState.proxyProviders || typeof pool.mihomoState.proxyProviders !== "object" || Array.isArray(pool.mihomoState.proxyProviders)) {
    pool.mihomoState.proxyProviders = {};
  }
  if (!pool.mihomoState.egressIdentities || typeof pool.mihomoState.egressIdentities !== "object" || Array.isArray(pool.mihomoState.egressIdentities)) {
    pool.mihomoState.egressIdentities = {};
  }
  return pool.mihomoState.proxyProviders;
}

function getMutableNodeState(pool, route) {
  const proxyProvider = stateKey(route?.proxyProvider || SELECTOR_PROXY_PROVIDER, "proxyProvider");
  const nodeName = stateKey(route?.nodeName, "nodeName");
  const providers = normalizeStateContainer(pool);
  const providerState = ensureObject(providers, proxyProvider);
  const nodes = ensureObject(providerState, "nodes");
  return { proxyProvider, nodeName, nodeState: ensureObject(nodes, nodeName) };
}

function getMutableBusinessState(pool, route, businessProviderId) {
  const businessProvider = stateKey(businessProviderId, "businessProvider");
  const { nodeState } = getMutableNodeState(pool, route);
  const business = ensureObject(nodeState, "business");
  const previous = business[businessProvider] && typeof business[businessProvider] === "object"
    ? business[businessProvider]
    : {};
  business[businessProvider] = previous;
  return previous;
}

function getMutableEgressBusinessState(pool, identityKey, businessProviderId) {
  const identity = stateKey(identityKey, "identityKey");
  const businessProvider = stateKey(businessProviderId, "businessProvider");
  normalizeStateContainer(pool);
  const identityState = ensureObject(pool.mihomoState.egressIdentities, identity);
  const business = ensureObject(identityState, "business");
  const previous = business[businessProvider] && typeof business[businessProvider] === "object"
    ? business[businessProvider]
    : {};
  business[businessProvider] = previous;
  return previous;
}

function truncateError(errorText) {
  const normalized = typeof errorText === "string" ? errorText : String(errorText || "");
  return normalized.slice(0, 500);
}

function selectMihomoBusinessScope(pool, config, route, businessProviderId, nowMs) {
  const egress = getMihomoNodeEgress(pool, route);
  if (config.egressScopedCooldown === true && isMihomoStableEgress(egress, nowMs)) {
    return {
      kind: "egress",
      identityKey: egress.identityKey,
      egress,
      state: getMihomoEgressBusinessState(pool, egress.identityKey, businessProviderId),
    };
  }
  return {
    kind: "node",
    identityKey: null,
    egress,
    state: getMihomoNodeBusinessState(pool, route, businessProviderId),
  };
}

function assignMihomoFailureState(state, { status, error, lastErrorType, nowMs, cooldownMs }) {
  const previousLevel = Math.max(0, Number(state.backoffLevel) || 0);
  Object.assign(state, {
    cooldownUntil: new Date(nowMs + cooldownMs).toISOString(),
    backoffLevel: previousLevel + 1,
    lastStatus: Number(status) || status || null,
    lastErrorType,
    lastError: truncateError(error),
    lastErrorAt: new Date(nowMs).toISOString(),
  });
}

function shouldPersistSuccess(state, nowMs) {
  if (!state || typeof state !== "object") return true;
  if (Number(state.backoffLevel) > 0 || state.lastErrorType || state.lastError || Number(state.lastStatus) >= 400) return true;
  if (!state.lastSuccessAt) return true;
  const lastSuccessAt = Date.parse(state.lastSuccessAt);
  return !Number.isFinite(lastSuccessAt) || nowMs - lastSuccessAt > 60000;
}

export async function recordMihomoNodeEgress({
  proxyPoolId,
  route,
  egress,
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  let updated = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const { nodeState } = getMutableNodeState(current, route);
    const next = normalizeEgressRecord(egress) || {
      ip: null,
      family: null,
      identityKey: null,
      confidence: "unknown",
      observedIps: [],
      sampleCount: 0,
      successfulSamples: 0,
      observedAt: null,
      expiresAt: null,
      lastProbeAt: nowMs,
      lastProbeError: "No valid egress sample",
      needsProbe: true,
    };
    const previous = normalizeEgressRecord(nodeState.egress);
    // A failed refresh should not erase a previously observed identity. The
    // mapping naturally becomes stale through expiresAt and routing will then
    // fall back to node semantics.
    nodeState.egress = next.confidence === "unknown" && previous?.identityKey
      ? { ...previous, lastProbeAt: next.lastProbeAt || nowMs, lastProbeError: next.lastProbeError, needsProbe: true }
      : next;
    updated = true;
    return current;
  });
  return { updated, pool };
}

export async function clearMihomoNodeEgress({
  proxyPoolId,
  route,
  mutatePool = defaultMutateProxyPool,
} = {}) {
  let updated = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const { nodeState } = getMutableNodeState(current, route);
    delete nodeState.egress;
    updated = true;
    return current;
  });
  return { updated, pool };
}

export async function clearMihomoEgressCooldown({
  proxyPoolId,
  identityKey,
  businessProviderId,
  mutatePool = defaultMutateProxyPool,
} = {}) {
  let updated = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const state = getMutableEgressBusinessState(current, identityKey, businessProviderId);
    Object.assign(state, {
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: null,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: state.lastSuccessAt || null,
    });
    updated = true;
    return current;
  });
  return { updated, pool };
}

export async function recordMihomoRouteFailure({
  proxyPoolId,
  route,
  businessProviderId,
  status,
  error,
  resetsAtMs = null,
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  if (!isIpCandidateRateLimitError(status, error)) return { updated: false, cooldownMs: 0, pool: null };

  let outcome = { updated: false, cooldownMs: 0, pool: null };
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const config = normalizeMihomoConfig(current.mihomo);
    const scope = selectMihomoBusinessScope(current, config, route, businessProviderId, nowMs);
    const previous = scope.kind === "egress"
      ? getMutableEgressBusinessState(current, scope.identityKey, businessProviderId)
      : getMutableBusinessState(current, route, businessProviderId);
    const cooldownMs = getCooldownMs(config, previous, resetsAtMs, nowMs);
    const lastErrorType = classifyRateLimitError(status, error);
    assignMihomoFailureState(previous, { status, error, lastErrorType, nowMs, cooldownMs });
    if (scope.kind === "node") {
      const { nodeState } = getMutableNodeState(current, route);
      if (nodeState.egress && typeof nodeState.egress === "object") nodeState.egress.needsProbe = true;
    }
    outcome = { updated: true, cooldownMs, lastErrorType, scope: scope.kind, identityKey: scope.identityKey };
    return current;
  });
  outcome.pool = pool;
  return outcome;
}

export async function recordMihomoRouteSuccess({
  proxyPoolId,
  route,
  businessProviderId,
  mutatePool = defaultMutateProxyPool,
  getPool = null,
  nowMs = Date.now(),
} = {}) {
  const readPool = getPool || (mutatePool === defaultMutateProxyPool ? defaultGetProxyPoolById : null);
  if (readPool) {
    const snapshot = await readPool(proxyPoolId);
    if (!snapshot?.mihomo || typeof snapshot.mihomo !== "object") return { updated: false, pool: snapshot || null };
    const config = normalizeMihomoConfig(snapshot.mihomo);
    const scope = selectMihomoBusinessScope(snapshot, config, route, businessProviderId, nowMs);
    if (!shouldPersistSuccess(scope.state, nowMs)) {
      return { updated: false, pool: snapshot, scope: scope.kind, identityKey: scope.identityKey };
    }
  }
  let updated = false;
  let scopeName = "node";
  let identityKey = null;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const config = normalizeMihomoConfig(current.mihomo);
    const scope = selectMihomoBusinessScope(current, config, route, businessProviderId, nowMs);
    scopeName = scope.kind;
    identityKey = scope.identityKey;
    const state = scope.kind === "egress"
      ? getMutableEgressBusinessState(current, scope.identityKey, businessProviderId)
      : getMutableBusinessState(current, route, businessProviderId);
    Object.assign(state, {
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: 200,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: new Date(nowMs).toISOString(),
    });
    updated = true;
    return current;
  });
  return { updated, pool, scope: scopeName, identityKey };
}

export async function clearMihomoRouteCooldown({
  proxyPoolId,
  route,
  businessProviderId,
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  let updated = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const state = getMutableBusinessState(current, route, businessProviderId);
    Object.assign(state, {
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: null,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: state.lastSuccessAt || null,
    });
    updated = true;
    return current;
  });
  return { updated, pool };
}
