import { isMihomoProxyPool } from "./proxyPoolTypes.js";

function clonePool(pool) {
  if (!pool || typeof pool !== "object") return pool;
  return {
    ...pool,
    mihomo: pool.mihomo && typeof pool.mihomo === "object" ? { ...pool.mihomo } : pool.mihomo,
  };
}

/**
 * Convert an internal proxy pool to the public API representation.
 * Mihomo state is intentionally kept server-side; controllerSecret is never
 * returned, including when an old database stored it at the top level.
 */
export function toPublicProxyPool(pool) {
  if (!pool) return null;
  const dto = clonePool(pool);
  delete dto.controllerSecret;

  if (isMihomoProxyPool(pool)) {
    const mihomo = dto.mihomo && typeof dto.mihomo === "object" ? dto.mihomo : {};
    const controllerSecretConfigured = Boolean(mihomo.controllerSecret);
    delete mihomo.controllerSecret;
    dto.mihomo = { ...mihomo, controllerSecretConfigured };
    delete dto.mihomoState;
  }

  return dto;
}

export function toPublicProxyPools(pools = []) {
  return pools.map(toPublicProxyPool);
}
