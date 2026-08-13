export const PROXY_POOL_TYPE_VALUES = [
  "http",
  "vercel",
  "cloudflare",
  "deno",
  "mihomo",
];

export const PROXY_POOL_TYPES = new Set(PROXY_POOL_TYPE_VALUES);

export const RELAY_PROXY_POOL_TYPES = new Set(["vercel", "cloudflare", "deno"]);

export function normalizeProxyPoolType(type) {
  return PROXY_POOL_TYPES.has(type) ? type : "http";
}

export function isRelayProxyPoolType(typeOrPool) {
  const type = typeof typeOrPool === "string" ? typeOrPool : typeOrPool?.type;
  return RELAY_PROXY_POOL_TYPES.has(type);
}

export function isMihomoProxyPool(typeOrPool) {
  const type = typeof typeOrPool === "string" ? typeOrPool : typeOrPool?.type;
  return type === "mihomo";
}
