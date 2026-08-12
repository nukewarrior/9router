import { fetch as undiciFetch } from "undici";
import { getSettings } from "@/lib/localDb";

export const MIHOMO_CONTROLLER_TIMEOUT_MS = 5000;

const REQUEST_PATHS = {
  version: "/version",
  providers: "/providers/proxies",
  proxies: "/proxies",
};

export class MihomoControllerError extends Error {
  constructor(code, message, { status = null, endpoint = null } = {}) {
    super(message);
    this.name = "MihomoControllerError";
    this.code = code;
    if (status !== null && status !== undefined) this.status = status;
    if (endpoint) this.endpoint = endpoint;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function endpointLabel(path) {
  return path.startsWith("/proxies/") ? "/proxies/:selector" : path;
}

export function assertHttpUrl(value, field = "url", { allowEmpty = false } = {}) {
  const text = asTrimmedString(value);
  if (!text && allowEmpty) return "";
  if (!text) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", `${field} is required`);
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", `${field} must be a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", `${field} must use http or https`);
  }

  if (!parsed.hostname) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", `${field} must include a host`);
  }

  return text;
}

function validateRequestConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", "Mihomo Controller configuration is required");
  }

  const controllerUrl = assertHttpUrl(config.controllerUrl, "controllerUrl");
  const secret = asTrimmedString(config.secret);
  return { ...config, controllerUrl, secret };
}

export function validateMihomoControllerConfig(config, {
  requireEnabled = false,
  requireSelection = true,
} = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", "Mihomo Controller configuration is required");
  }
  const enabled = config.enabled === true;
  const normalized = {
    ...config,
    controllerUrl: assertHttpUrl(config.controllerUrl, "controllerUrl", { allowEmpty: !enabled }),
    secret: asTrimmedString(config.secret),
  };
  const id = asTrimmedString(normalized.id);
  const selectorName = asTrimmedString(normalized.selectorName);
  const proxyUrl = assertHttpUrl(normalized.proxyUrl, "proxyUrl", {
    allowEmpty: normalized.enabled !== true,
  });
  const providerNames = Array.isArray(normalized.providerNames)
    ? [...new Set(normalized.providerNames.map(asTrimmedString).filter(Boolean))]
    : [];
  const interval = normalized.syncIntervalMinutes === undefined || normalized.syncIntervalMinutes === null || normalized.syncIntervalMinutes === ""
    ? 5
    : Number(normalized.syncIntervalMinutes);

  if (!id) throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", "id is required");
  if (requireEnabled && normalized.enabled !== true) {
    throw new MihomoControllerError("MIHOMO_CONTROLLER_DISABLED", "Mihomo Controller is disabled");
  }
  if (requireSelection && normalized.enabled === true && !selectorName) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", "selectorName is required");
  }
  if (requireSelection && normalized.enabled === true && providerNames.length === 0) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", "providerNames must not be empty");
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
    throw new MihomoControllerError("MIHOMO_INVALID_CONFIG", "syncIntervalMinutes must be between 1 and 1440");
  }

  return {
    ...normalized,
    id,
    enabled: normalized.enabled === true,
    proxyUrl,
    selectorName,
    providerNames,
    syncIntervalMinutes: interval,
  };
}

function buildRequestUrl(controllerUrl, path) {
  const base = new URL(controllerUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const requestPath = path.startsWith("/") ? path : `/${path}`;
  base.pathname = `${basePath}${requestPath}` || "/";
  base.search = "";
  base.hash = "";
  return base.toString();
}

function normalizeRequestError(error, path) {
  if (error instanceof MihomoControllerError) return error;
  if (error?.name === "AbortError") {
    return new MihomoControllerError(
      "MIHOMO_TIMEOUT",
      "Mihomo Controller request timed out",
      { endpoint: endpointLabel(path) },
    );
  }
  return new MihomoControllerError(
    "MIHOMO_NETWORK_ERROR",
    "Mihomo Controller request failed",
    { endpoint: endpointLabel(path) },
  );
}

/**
 * Make a Controller request through undici directly. This intentionally does
 * not use the application's global fetch, which may be patched for outbound
 * proxy routing.
 */
export async function requestMihomoController(config, path, {
  method = "GET",
  body,
  timeoutMs = MIHOMO_CONTROLLER_TIMEOUT_MS,
} = {}) {
  const normalized = validateRequestConfig(config);
  const requestPath = typeof path === "string" && path.startsWith("/") ? path : `/${path || ""}`;
  const url = buildRequestUrl(normalized.controllerUrl, requestPath);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (normalized.secret) headers.Authorization = `Bearer ${normalized.secret}`;

  let response;
  try {
    response = await undiciFetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abortController.signal,
    });
  } catch (error) {
    throw normalizeRequestError(error, requestPath);
  } finally {
    clearTimeout(timer);
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new MihomoControllerError(
      "MIHOMO_INVALID_RESPONSE",
      "Mihomo Controller returned an unreadable response",
      { status: response.status, endpoint: endpointLabel(requestPath) },
    );
  }

  if (!response.ok) {
    throw new MihomoControllerError(
      "MIHOMO_HTTP_ERROR",
      `Mihomo Controller request failed with status ${response.status}`,
      { status: response.status, endpoint: endpointLabel(requestPath) },
    );
  }

  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new MihomoControllerError(
      "MIHOMO_INVALID_RESPONSE",
      "Mihomo Controller returned invalid JSON",
      { status: response.status, endpoint: endpointLabel(requestPath) },
    );
  }
}

export async function getMihomoVersion(config) {
  const data = await requestMihomoController(config, REQUEST_PATHS.version);
  if (!data || typeof data !== "object" || typeof data.version !== "string" || !data.version.trim()) {
    throw new MihomoControllerError("MIHOMO_INVALID_RESPONSE", "Mihomo Controller returned an invalid version response", {
      endpoint: REQUEST_PATHS.version,
    });
  }
  return data;
}

export async function getMihomoProviderProxies(config) {
  const data = await requestMihomoController(config, REQUEST_PATHS.providers);
  if (!data || typeof data !== "object" || !data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) {
    throw new MihomoControllerError("MIHOMO_INVALID_RESPONSE", "Mihomo Controller returned an invalid proxy provider response", {
      endpoint: REQUEST_PATHS.providers,
    });
  }
  return data.providers;
}

export async function getMihomoProxies(config) {
  const data = await requestMihomoController(config, REQUEST_PATHS.proxies);
  if (!data || typeof data !== "object" || !data.proxies || typeof data.proxies !== "object" || Array.isArray(data.proxies)) {
    throw new MihomoControllerError("MIHOMO_INVALID_RESPONSE", "Mihomo Controller returned an invalid proxy response", {
      endpoint: REQUEST_PATHS.proxies,
    });
  }
  return data.proxies;
}

function requireSelectionValue(value, name) {
  const text = asTrimmedString(value);
  if (!text) {
    throw new MihomoControllerError("MIHOMO_SELECTION_INVALID", `${name} is required`);
  }
  return text;
}

/**
 * Validate membership in the current Selector and select a node. `proxies`
 * can be supplied by a caller that already performed GET /proxies.
 */
export async function selectMihomoNode(config, selectorName, nodeName, { proxies } = {}) {
  const normalized = validateRequestConfig(config);
  const selector = requireSelectionValue(selectorName, "selectorName");
  const node = requireSelectionValue(nodeName, "nodeName");
  const currentProxies = proxies || await getMihomoProxies(normalized);
  const selectorConfig = currentProxies?.[selector];

  if (!selectorConfig || selectorConfig.type !== "Selector") {
    throw new MihomoControllerError(
      "MIHOMO_SELECTOR_NOT_FOUND",
      "Mihomo Selector was not found",
      { endpoint: REQUEST_PATHS.proxies },
    );
  }

  if (!Array.isArray(selectorConfig.all) || !selectorConfig.all.includes(node)) {
    throw new MihomoControllerError(
      "MIHOMO_NODE_NOT_SELECTABLE",
      "Mihomo node is not currently selectable by the configured Selector",
      { endpoint: REQUEST_PATHS.proxies },
    );
  }

  return requestMihomoController(normalized, `/proxies/${encodeURIComponent(selector)}`, {
    method: "PUT",
    body: { name: node },
  });
}

function validateRouting(routing) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw new MihomoControllerError("MIHOMO_SELECTION_INVALID", "Mihomo routing metadata is required");
  }
  for (const field of ["poolId", "controllerId", "providerName", "nodeName", "selectorName"]) {
    if (typeof routing[field] !== "string" || !routing[field].trim()) {
      throw new MihomoControllerError("MIHOMO_SELECTION_INVALID", `${field} is required`);
    }
  }
  return routing;
}

function getStoredController(settings) {
  const stored = settings?.mihomoController;
  if (stored?.config && typeof stored.config === "object") {
    return { ...stored.config, status: stored.status || stored.config.status };
  }
  return stored;
}

function getSelectionMutexes() {
  if (!globalThis.__mihomoSelectionMutexes) globalThis.__mihomoSelectionMutexes = new Map();
  return globalThis.__mihomoSelectionMutexes;
}

async function acquireSelectionMutex(key) {
  const mutexes = getSelectionMutexes();
  const previous = mutexes.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  mutexes.set(key, current);
  await previous;
  return () => {
    release();
    if (mutexes.get(key) === current) mutexes.delete(key);
  };
}

/**
 * Serialize a Mihomo Selector switch and the connection operation that uses
 * it. The operation is awaited only until it returns (normally a Response,
 * i.e. response headers received), so the lock does not pin the response body.
 */
export async function withMihomoSelection(routing, operation) {
  const normalizedRouting = validateRouting(routing);
  if (typeof operation !== "function") {
    throw new MihomoControllerError("MIHOMO_SELECTION_INVALID", "Mihomo selection operation is required");
  }

  const key = `${normalizedRouting.controllerId}\u0000${normalizedRouting.selectorName}`;
  const release = await acquireSelectionMutex(key);
  try {
    let settings;
    try {
      settings = await getSettings();
    } catch {
      throw new MihomoControllerError("MIHOMO_SETTINGS_ERROR", "Mihomo Controller settings could not be read");
    }

    const controller = getStoredController(settings);
    if (!controller || controller.enabled !== true) {
      throw new MihomoControllerError("MIHOMO_CONTROLLER_DISABLED", "Mihomo Controller is disabled");
    }
    if (asTrimmedString(controller.id) !== normalizedRouting.controllerId) {
      throw new MihomoControllerError("MIHOMO_CONTROLLER_MISMATCH", "Mihomo Controller configuration does not match the route");
    }

    const current = validateRequestConfig(controller);
    await selectMihomoNode(
      current,
      normalizedRouting.selectorName,
      normalizedRouting.nodeName,
    );
    return await operation();
  } finally {
    release();
  }
}

export function createMihomoControllerClient(config) {
  return {
    getVersion: () => getMihomoVersion(config),
    getProviders: () => getMihomoProviderProxies(config),
    getProxies: () => getMihomoProxies(config),
    selectNode: (selectorName, nodeName, options) => selectMihomoNode(config, selectorName, nodeName, options),
  };
}
