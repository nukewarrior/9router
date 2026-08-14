import { getProxyPoolById as defaultGetProxyPoolById, mutateProxyPool as defaultMutateProxyPool } from "@/models";
import { createEmptyMihomoState, normalizeMihomoConfig } from "./mihomoConfig.js";
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
export const MIHOMO_NODE_DIRECTORY_CACHE_MAX_ENTRIES = 200;

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

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

  for (const [key, entry] of nodeDirectoryCache.entries()) {
    if (!entry || entry.expiresAt <= nowMs) nodeDirectoryCache.delete(key);
  }
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
  while (nodeDirectoryCache.size > MIHOMO_NODE_DIRECTORY_CACHE_MAX_ENTRIES) {
    const oldestKey = nodeDirectoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    nodeDirectoryCache.delete(oldestKey);
  }
  return clone(value);
}

export function getMihomoNodeDirectoryCacheSize() {
  return nodeDirectoryCache.size;
}

export function clearMihomoNodeDirectoryCache(poolId = null) {
  if (poolId) nodeDirectoryCache.delete(poolId);
  else nodeDirectoryCache.clear();
}

const RESERVED_STATE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stateKey(value, fieldName) {
  const key = text(value);
  if (!key || RESERVED_STATE_KEYS.has(key) || /[\u0000-\u001f\u007f]/.test(key)) {
    const error = new Error(`${fieldName} is required and must be a safe state key`);
    error.code = "MIHOMO_INVALID_STATE_KEY";
    throw error;
  }
  return key;
}

function normalizeMaintenanceState(value, selectedModels = []) {
  const base = createEmptyMihomoState().maintenance;
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const models = Array.isArray(value.selectedModels)
    ? [...new Set(value.selectedModels.map((modelId) => stateKey(modelId, "modelId")))].sort()
    : selectedModels;
  const healthyByModel = {};
  if (value.healthyByModel && typeof value.healthyByModel === "object" && !Array.isArray(value.healthyByModel)) {
    for (const [modelId, count] of Object.entries(value.healthyByModel)) {
      const safeModelId = stateKey(modelId, "modelId");
      healthyByModel[safeModelId] = Math.max(0, Math.floor(Number(count) || 0));
    }
  }
  return {
    cycleId: text(value.cycleId) || null,
    status: ["idle", "discovering", "probing-egress", "probing-business", "complete", "degraded"].includes(value.status)
      ? value.status
      : "idle",
    startedAt: normalizeTimestamp(value.startedAt),
    completedAt: normalizeTimestamp(value.completedAt),
    nextRunAt: normalizeTimestamp(value.nextRunAt),
    selectedModels: models,
    nodeCount: Math.max(0, Math.floor(Number(value.nodeCount) || 0)),
    mappedNodeCount: Math.max(0, Math.floor(Number(value.mappedNodeCount) || 0)),
    distinctEgressCount: Math.max(0, Math.floor(Number(value.distinctEgressCount) || 0)),
    totalBusinessChecks: Math.max(0, Math.floor(Number(value.totalBusinessChecks) || 0)),
    completedBusinessChecks: Math.max(0, Math.floor(Number(value.completedBusinessChecks) || 0)),
    healthyByModel,
    lastError: truncateError(value.lastError) || null,
  };
}

/**
 * Convert the legacy node/business state into the v2 shape without carrying
 * model-less business evidence forward. This is intentionally pure: callers
 * decide when the normalized value is persisted through mutateProxyPool().
 */
export function migrateMihomoState(input = null) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const migrated = createEmptyMihomoState();
  const proxyProviders = source.proxyProviders && typeof source.proxyProviders === "object" && !Array.isArray(source.proxyProviders)
    ? source.proxyProviders
    : {};

  for (const [providerName, providerValue] of Object.entries(proxyProviders)) {
    const safeProviderName = stateKey(providerName, "proxyProvider");
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const sourceNodes = providerValue.nodes && typeof providerValue.nodes === "object" && !Array.isArray(providerValue.nodes)
      ? providerValue.nodes
      : {};
    const nodes = {};
    for (const [nodeName, nodeValue] of Object.entries(sourceNodes)) {
      const safeNodeName = stateKey(nodeName, "nodeName");
      if (!nodeValue || typeof nodeValue !== "object" || Array.isArray(nodeValue)) continue;
      const egress = normalizeEgressRecord(nodeValue.egress);
      const mapping = egress
        ? {
          ...egress,
          mappingVersion: Math.max(1, Math.floor(Number(egress.mappingVersion) || 1)),
        }
        : null;
      nodes[safeNodeName] = {
        egress: mapping,
        transport: normalizeTransportRecord(nodeValue.transport),
      };
    }
    migrated.proxyProviders[safeProviderName] = { nodes };
  }

  if (Number(source.version) >= 2) {
    const sourceIdentities = source.egressIdentities
      && typeof source.egressIdentities === "object"
      && !Array.isArray(source.egressIdentities)
      ? source.egressIdentities
      : {};
    for (const [identityKey, identityValue] of Object.entries(sourceIdentities)) {
      const safeIdentityKey = stateKey(identityKey, "identityKey");
      if (!identityValue || typeof identityValue !== "object" || Array.isArray(identityValue)) continue;
      const sourceModels = identityValue.models
        && typeof identityValue.models === "object"
        && !Array.isArray(identityValue.models)
        ? identityValue.models
        : {};
      const models = {};
      for (const [modelId, modelValue] of Object.entries(sourceModels)) {
        const safeModelId = stateKey(modelId, "modelId");
        models[safeModelId] = normalizeModelHealthRecord(modelValue);
      }
      migrated.egressIdentities[safeIdentityKey] = { models };
    }
  }

  migrated.maintenance = normalizeMaintenanceState(source.version >= 2 ? source.maintenance : null);
  return migrated;
}

export const normalizeMihomoState = migrateMihomoState;

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) parent[key] = {};
  return parent[key];
}

function emptyBusinessState() {
  return emptyMihomoModelHealthState();
}

function emptyMihomoModelHealthState() {
  return {
    status: "unknown",
    refreshAt: null,
    expiresAt: null,
    cooldownUntil: null,
    backoffLevel: 0,
    lastStatus: null,
    lastErrorType: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    evidenceVersion: 0,
    evidenceStartedAtMs: null,
    source: null,
  };
}

function emptyMihomoTransportState() {
  return {
    status: "unknown",
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorType: null,
    lastError: null,
  };
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isFinite(Number(value)) && typeof value !== "string") return Number(value);
  return text(value) || null;
}

function normalizeModelHealthRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMihomoModelHealthState();
  const normalized = emptyMihomoModelHealthState();
  const statusValues = new Set(["healthy", "refreshing", "cooling", "invalid", "unknown"]);
  normalized.status = statusValues.has(value.status) ? value.status : "unknown";
  normalized.refreshAt = normalizeTimestamp(value.refreshAt);
  normalized.expiresAt = normalizeTimestamp(value.expiresAt);
  normalized.cooldownUntil = normalizeTimestamp(value.cooldownUntil);
  normalized.backoffLevel = Math.max(0, Math.floor(Number(value.backoffLevel) || 0));
  normalized.lastStatus = Number.isFinite(Number(value.lastStatus)) ? Number(value.lastStatus) : null;
  normalized.lastErrorType = text(value.lastErrorType) || null;
  normalized.lastError = truncateError(value.lastError) || null;
  normalized.lastErrorAt = normalizeTimestamp(value.lastErrorAt);
  normalized.lastSuccessAt = normalizeTimestamp(value.lastSuccessAt);
  normalized.evidenceVersion = Math.max(0, Math.floor(Number(value.evidenceVersion) || 0));
  normalized.evidenceStartedAtMs = finiteOrNull(value.evidenceStartedAtMs);
  normalized.source = ["probe", "request"].includes(value.source) ? value.source : null;
  return normalized;
}

function normalizeTransportRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMihomoTransportState();
  return {
    status: ["healthy", "degraded", "cooling", "unknown"].includes(value.status) ? value.status : "unknown",
    consecutiveFailures: Math.max(0, Math.floor(Number(value.consecutiveFailures) || 0)),
    cooldownUntil: normalizeTimestamp(value.cooldownUntil),
    lastSuccessAt: normalizeTimestamp(value.lastSuccessAt),
    lastFailureAt: normalizeTimestamp(value.lastFailureAt),
    lastErrorType: text(value.lastErrorType) || null,
    lastError: truncateError(value.lastError) || null,
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
    mappingVersion: Math.max(0, Math.floor(Number(value.mappingVersion) || 0)),
  };
}

export function getMihomoNodeEgress(pool, route) {
  const proxyProvider = stateKey(route?.proxyProvider || SELECTOR_PROXY_PROVIDER, "proxyProvider");
  const nodeName = stateKey(route?.nodeName, "nodeName");
  const state = migrateMihomoState(pool?.mihomoState);
  return normalizeEgressRecord(state.proxyProviders?.[proxyProvider]?.nodes?.[nodeName]?.egress);
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

export function getMihomoModelHealthState(pool, identityKey, modelId) {
  const identity = stateKey(identityKey, "identityKey");
  const model = stateKey(modelId, "modelId");
  const state = migrateMihomoState(pool?.mihomoState);
  return state.egressIdentities?.[identity]?.models?.[model]
    ? normalizeModelHealthRecord(state.egressIdentities[identity].models[model])
    : emptyMihomoModelHealthState();
}

// Kept as a function-level compatibility alias while callers migrate to the
// model-health name. The persisted path is always modelId-scoped in v2.
export function getMihomoEgressBusinessState(pool, identityKey, modelId) {
  return getMihomoModelHealthState(pool, identityKey, modelId);
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

export function getMihomoNodeTransportState(pool, route) {
  const proxyProvider = stateKey(route?.proxyProvider || SELECTOR_PROXY_PROVIDER, "proxyProvider");
  const nodeName = stateKey(route?.nodeName, "nodeName");
  const state = migrateMihomoState(pool?.mihomoState);
  return state.proxyProviders?.[proxyProvider]?.nodes?.[nodeName]?.transport
    ? normalizeTransportRecord(state.proxyProviders[proxyProvider].nodes[nodeName].transport)
    : emptyMihomoTransportState();
}

export function getMihomoNodeBusinessState(pool, route) {
  return getMihomoNodeTransportState(pool, route);
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

export function getMihomoModelHealthCooldownMs(config, previousState, resetsAtMs = null, nowMs = Date.now()) {
  return getCooldownMs(normalizeMihomoConfig(config), previousState, resetsAtMs, nowMs);
}

function normalizeStateContainer(pool) {
  pool.mihomoState = migrateMihomoState(pool.mihomoState);
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
  const identityKey = getRouteIdentityKey(route);
  if (!identityKey) return emptyMihomoModelHealthState();
  return getMutableModelHealthState(pool, identityKey, businessProviderId);
}

function getMutableModelHealthState(pool, identityKey, modelId) {
  const identity = stateKey(identityKey, "identityKey");
  const model = stateKey(modelId, "modelId");
  normalizeStateContainer(pool);
  const identityState = ensureObject(pool.mihomoState.egressIdentities, identity);
  const models = ensureObject(identityState, "models");
  const previous = models[model] && typeof models[model] === "object"
    ? normalizeModelHealthRecord(models[model])
    : emptyMihomoModelHealthState();
  models[model] = previous;
  return previous;
}

function getMutableEgressBusinessState(pool, identityKey, modelId) {
  return getMutableModelHealthState(pool, identityKey, modelId);
}

function getRouteIdentityKey(route) {
  const rawIdentityKey = route?.egressIdentityKey
    || route?.identityKey
    || route?.egressSnapshot?.identityKey;
  return rawIdentityKey ? stateKey(rawIdentityKey, "identityKey") : null;
}

function truncateError(errorText) {
  const normalized = typeof errorText === "string" ? errorText : String(errorText || "");
  return normalized.slice(0, 500);
}

function getMihomoAttemptEgressSnapshot(route) {
  const snapshot = route?.egressSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return {
    identityKey: text(snapshot.identityKey) || null,
    confidence: text(snapshot.confidence) || "unknown",
    observedAt: finiteOrNull(snapshot.observedAt),
    expiresAt: finiteOrNull(snapshot.expiresAt),
    startedAtMs: finiteOrNull(snapshot.startedAtMs),
    scopeEligible: snapshot.scopeEligible === true,
  };
}

function selectMihomoBusinessScope(pool, route, modelId) {
  // An attempt's business scope is immutable. The node mapping is deliberately
  // not consulted here because a background probe may have remapped it after
  // the request started.
  const egress = getMihomoAttemptEgressSnapshot(route);
  const identityKey = getRouteIdentityKey(route) || egress?.identityKey || null;
  return {
    kind: "egress",
    identityKey,
    egress,
    state: identityKey ? getMihomoModelHealthState(pool, identityKey, modelId) : emptyMihomoModelHealthState(),
  };
}

function markMihomoAttemptEgressNeedsProbe(nodeState, route) {
  const attemptSnapshot = getMihomoAttemptEgressSnapshot(route);
  const currentEgress = normalizeEgressRecord(nodeState?.egress);
  if (!attemptSnapshot?.identityKey || !currentEgress?.identityKey) return false;
  if (attemptSnapshot.identityKey !== currentEgress.identityKey) return false;
  nodeState.egress.needsProbe = true;
  return true;
}

function assignMihomoFailureState(state, {
  status,
  error,
  lastErrorType,
  nowMs,
  cooldownMs,
  evidenceStartedAtMs = nowMs,
  source = "request",
  stateStatus = "cooling",
}) {
  const previousLevel = Math.max(0, Number(state.backoffLevel) || 0);
  Object.assign(state, {
    status: stateStatus,
    cooldownUntil: new Date(nowMs + cooldownMs).toISOString(),
    backoffLevel: previousLevel + 1,
    lastStatus: Number(status) || status || null,
    lastErrorType,
    lastError: truncateError(error),
    lastErrorAt: new Date(nowMs).toISOString(),
    evidenceVersion: Math.max(0, Number(state.evidenceVersion) || 0) + 1,
    evidenceStartedAtMs: Number.isFinite(Number(evidenceStartedAtMs)) ? Number(evidenceStartedAtMs) : nowMs,
    source,
  });
}

function shouldPersistSuccess(state, nowMs) {
  if (!state || typeof state !== "object") return true;
  if (Number(state.backoffLevel) > 0 || state.lastErrorType || state.lastError || Number(state.lastStatus) >= 400) return true;
  if (!state.lastSuccessAt) return true;
  const lastSuccessAt = Date.parse(state.lastSuccessAt);
  return !Number.isFinite(lastSuccessAt) || nowMs - lastSuccessAt > 60000;
}

function hasNewerFailure(state, attemptStartedAtMs) {
  const attemptStartedAt = Number(attemptStartedAtMs);
  if (!Number.isFinite(attemptStartedAt)) return false;
  const evidenceStartedAt = Number(state?.evidenceStartedAtMs);
  if (Number.isFinite(evidenceStartedAt) && evidenceStartedAt > attemptStartedAt && state?.lastErrorAt) return true;
  const lastErrorAt = Date.parse(state?.lastErrorAt || "");
  return Number.isFinite(lastErrorAt) && lastErrorAt > attemptStartedAt;
}

export async function recordMihomoModelHealthFailure({
  proxyPoolId,
  identityKey,
  modelId,
  status = null,
  error = "",
  errorType = null,
  stateStatus = "unknown",
  cooldownMs = 0,
  source = "probe",
  evidenceStartedAtMs = Date.now(),
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  let updated = false;
  let stale = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const state = getMutableModelHealthState(current, identityKey, modelId);
    const startedAtMs = Number(evidenceStartedAtMs);
    if (Number.isFinite(Number(state.evidenceStartedAtMs))
      && Number.isFinite(startedAtMs)
      && Number(state.evidenceStartedAtMs) > startedAtMs) {
      stale = true;
      return current;
    }
    const previousLevel = Math.max(0, Number(state.backoffLevel) || 0);
    Object.assign(state, {
      status: stateStatus,
      cooldownUntil: cooldownMs > 0 ? new Date(nowMs + cooldownMs).toISOString() : state.cooldownUntil || null,
      backoffLevel: cooldownMs > 0 ? previousLevel + 1 : previousLevel,
      lastStatus: Number.isFinite(Number(status)) ? Number(status) : null,
      lastErrorType: text(errorType) || null,
      lastError: truncateError(error) || null,
      lastErrorAt: new Date(nowMs).toISOString(),
      evidenceVersion: Math.max(0, Number(state.evidenceVersion) || 0) + 1,
      evidenceStartedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : nowMs,
      source,
    });
    updated = true;
    return current;
  });
  return { updated, stale, pool, identityKey, modelId };
}

export async function recordMihomoModelHealthSuccess({
  proxyPoolId,
  identityKey,
  modelId,
  source = "probe",
  evidenceStartedAtMs = Date.now(),
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  let updated = false;
  let stale = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const config = normalizeMihomoConfig(current.mihomo);
    const state = getMutableModelHealthState(current, identityKey, modelId);
    const startedAtMs = Number(evidenceStartedAtMs);
    if (hasNewerFailure(state, startedAtMs)) {
      state.lastSuccessAt = new Date(nowMs).toISOString();
      state.evidenceVersion = Math.max(0, Number(state.evidenceVersion) || 0) + 1;
      state.source = source;
      stale = true;
      updated = true;
      return current;
    }
    Object.assign(state, {
      status: "healthy",
      refreshAt: new Date(nowMs + config.businessHealthRefreshMs).toISOString(),
      expiresAt: new Date(nowMs + config.businessHealthTtlMs).toISOString(),
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: 200,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: new Date(nowMs).toISOString(),
      evidenceVersion: Math.max(0, Number(state.evidenceVersion) || 0) + 1,
      evidenceStartedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : nowMs,
      source,
    });
    updated = true;
    return current;
  });
  return { updated, stale, pool, identityKey, modelId };
}

export async function recordMihomoNodeEgress({
  proxyPoolId,
  route,
  egress,
  expectedMappingVersion = null,
  probeStartedAtMs = null,
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  let updated = false;
  let stale = false;
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
      mappingVersion: 0,
    };
    const previous = normalizeEgressRecord(nodeState.egress);
    const currentMappingVersion = Math.max(0, Number(previous?.mappingVersion) || 0);
    if (Number.isFinite(Number(expectedMappingVersion))
      && currentMappingVersion !== Number(expectedMappingVersion)) {
      stale = true;
      return current;
    }
    const startedAtMs = Number(probeStartedAtMs);
    if (previous?.lastProbeAt && Number.isFinite(startedAtMs) && Number(previous.lastProbeAt) > startedAtMs) {
      stale = true;
      return current;
    }
    // A failed refresh should not erase a previously observed identity. The
    // mapping naturally becomes stale through expiresAt and will then leave
    // the strict healthy pool.
    nodeState.egress = next.confidence === "unknown" && previous?.identityKey
      ? {
        ...previous,
        lastProbeAt: next.lastProbeAt || nowMs,
        lastProbeError: next.lastProbeError,
        needsProbe: true,
      }
      : {
        ...next,
        mappingVersion: currentMappingVersion + 1 || 1,
      };
    updated = true;
    return current;
  });
  return { updated, stale, pool };
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
  modelId = null,
  businessProviderId,
  mutatePool = defaultMutateProxyPool,
} = {}) {
  const selectedModelId = modelId || businessProviderId;
  let updated = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const state = getMutableModelHealthState(current, identityKey, selectedModelId);
    Object.assign(state, {
      status: "unknown",
      refreshAt: state.refreshAt || null,
      expiresAt: state.expiresAt || null,
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: null,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      evidenceStartedAtMs: state.evidenceStartedAtMs || null,
    });
    updated = true;
    return current;
  });
  return { updated, pool, modelId: selectedModelId };
}

export async function recordMihomoRouteFailure({
  proxyPoolId,
  route,
  modelId = null,
  businessProviderId,
  status,
  error,
  resetsAtMs = null,
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  if (!isIpCandidateRateLimitError(status, error)) return { updated: false, cooldownMs: 0, pool: null };
  const selectedModelId = modelId || businessProviderId;

  let outcome = { updated: false, cooldownMs: 0, pool: null };
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const config = normalizeMihomoConfig(current.mihomo);
    const scope = selectMihomoBusinessScope(current, route, selectedModelId);
    if (!scope.identityKey) return current;
    const previous = getMutableModelHealthState(current, scope.identityKey, selectedModelId);
    const cooldownMs = getCooldownMs(config, previous, resetsAtMs, nowMs);
    const lastErrorType = classifyRateLimitError(status, error);
    assignMihomoFailureState(previous, {
      status,
      error,
      lastErrorType,
      nowMs,
      cooldownMs,
      evidenceStartedAtMs: route?.attemptStartedAtMs,
      source: "request",
      stateStatus: "cooling",
    });
    const { nodeState } = getMutableNodeState(current, route);
    // Mark a mapping only when it is still the same identity observed by this
    // attempt. A remapped node must not make an old E1 failure invalidate E2.
    markMihomoAttemptEgressNeedsProbe(nodeState, route);
    outcome = {
      updated: true,
      cooldownMs,
      lastErrorType,
      scope: scope.kind,
      identityKey: scope.identityKey,
      modelId: selectedModelId,
    };
    return current;
  });
  outcome.pool = pool;
  return outcome;
}

export async function recordMihomoRouteSuccess({
  proxyPoolId,
  route,
  modelId = null,
  businessProviderId,
  mutatePool = defaultMutateProxyPool,
  getPool = null,
  nowMs = Date.now(),
} = {}) {
  const selectedModelId = modelId || businessProviderId;
  const readPool = getPool || (mutatePool === defaultMutateProxyPool ? defaultGetProxyPoolById : null);
  if (readPool) {
    const snapshot = await readPool(proxyPoolId);
    if (!snapshot?.mihomo || typeof snapshot.mihomo !== "object") return { updated: false, pool: snapshot || null };
    const config = normalizeMihomoConfig(snapshot.mihomo);
    const scope = selectMihomoBusinessScope(snapshot, route, selectedModelId);
    if (!shouldPersistSuccess(scope.state, nowMs)) {
      return { updated: false, pool: snapshot, scope: scope.kind, identityKey: scope.identityKey, modelId: selectedModelId };
    }
  }
  let updated = false;
  let scopeName = "node";
  let identityKey = null;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const config = normalizeMihomoConfig(current.mihomo);
    const scope = selectMihomoBusinessScope(current, route, selectedModelId);
    if (!scope.identityKey) return current;
    scopeName = scope.kind;
    identityKey = scope.identityKey;
    const state = getMutableModelHealthState(current, scope.identityKey, selectedModelId);

    // A request can finish successfully after a newer concurrent request has
    // already recorded a rate limit. Keep that newer cooldown intact; the
    // success belongs to the older attempt and must not reset it.
    if (hasNewerFailure(state, route?.attemptStartedAtMs)) {
      state.lastSuccessAt = new Date(nowMs).toISOString();
      state.evidenceVersion = Math.max(0, Number(state.evidenceVersion) || 0) + 1;
      updated = true;
      return current;
    }

    Object.assign(state, {
      status: "healthy",
      refreshAt: new Date(nowMs + config.businessHealthRefreshMs).toISOString(),
      expiresAt: new Date(nowMs + config.businessHealthTtlMs).toISOString(),
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: 200,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: new Date(nowMs).toISOString(),
      evidenceVersion: Math.max(0, Number(state.evidenceVersion) || 0) + 1,
      evidenceStartedAtMs: Number.isFinite(Number(route?.attemptStartedAtMs))
        ? Number(route.attemptStartedAtMs)
        : nowMs,
      source: "request",
    });
    updated = true;
    return current;
  });
  return { updated, pool, scope: scopeName, identityKey, modelId: selectedModelId };
}

export async function clearMihomoRouteCooldown({
  proxyPoolId,
  route,
  modelId = null,
  businessProviderId,
  mutatePool = defaultMutateProxyPool,
  nowMs = Date.now(),
} = {}) {
  const selectedModelId = modelId || businessProviderId;
  let updated = false;
  const pool = await mutatePool(proxyPoolId, (current) => {
    if (!current?.mihomo || typeof current.mihomo !== "object") return current;
    const identityKey = getRouteIdentityKey(route);
    if (!identityKey) return current;
    const state = getMutableModelHealthState(current, identityKey, selectedModelId);
    Object.assign(state, {
      status: "unknown",
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
  return { updated, pool, modelId: selectedModelId };
}
