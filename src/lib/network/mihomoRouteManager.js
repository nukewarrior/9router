import { getProxyPoolById } from "@/models";
import { createMihomoClient, MIHOMO_ERROR_CODES, validateMihomoControllerUrl } from "./mihomoClient.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import { mihomoSelectorMutex } from "./keyedMutex.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

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
