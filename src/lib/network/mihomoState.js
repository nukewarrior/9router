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
export function buildMihomoNodeDirectory({ selector, selectorName = null, proxies, providerDataByName = {}, providerNames = [], includeRegex = "", excludeRegex = "" } = {}) {
  const normalizedSelector = normalizeSelector(selector);
  const selectorNames = metadataNames(normalizedSelector.all);
  const proxyMap = proxies && typeof proxies === "object" ? proxies : {};
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
    nodes.push({
      key: `${proxyProvider}\0${nodeName}`,
      nodeName,
      proxyProvider,
      region: classifyNodeRegion(nodeName),
      type: text(metadata.type) || null,
      alive: metadataAlive(metadata),
      delayMs: metadataDelayMs(metadata),
      history: Array.isArray(metadata.history) ? clone(metadata.history) : [],
    });
  }

  return {
    selectorName: selectorName || normalizedSelector.name || null,
    selectorNow: text(normalizedSelector.now) || null,
    nodes,
    warnings,
  };
}

export async function discoverMihomoNodeDirectory({ poolId, client, selectorName, providerNames = [], includeRegex = "", excludeRegex = "", ttlMs = 30000, nowMs = Date.now() } = {}) {
  if (!poolId) throw new TypeError("poolId is required for Mihomo node discovery");
  if (!client) throw new TypeError("Mihomo client is required for node discovery");
  const cached = nodeDirectoryCache.get(poolId);
  if (cached && cached.expiresAt > nowMs) return clone(cached.value);

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
