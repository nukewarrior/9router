import { isIP } from "node:net";

const DEFAULT_CONTROLLER_TIMEOUT_MS = 3000;
const MAX_CONTROLLER_TIMEOUT_MS = 30000;
const DISALLOWED_HOSTNAMES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "metadata.google.internal",
]);

export const MIHOMO_ERROR_CODES = Object.freeze({
  TIMEOUT: "MIHOMO_CONTROLLER_TIMEOUT",
  UNREACHABLE: "MIHOMO_CONTROLLER_UNREACHABLE",
  UNAUTHORIZED: "MIHOMO_CONTROLLER_UNAUTHORIZED",
  SELECTOR_NOT_FOUND: "MIHOMO_SELECTOR_NOT_FOUND",
  PROVIDER_NOT_FOUND: "MIHOMO_PROVIDER_NOT_FOUND",
  INVALID_RESPONSE: "MIHOMO_INVALID_RESPONSE",
  SELECTOR_SWITCH_FAILED: "MIHOMO_SELECTOR_SWITCH_FAILED",
});

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTROLLER_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_CONTROLLER_TIMEOUT_MS);
}

function normalizeHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4ToOctets(hostname) {
  const octets = hostname.split(".").map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isDisallowedIp(hostname) {
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const octets = ipv4ToOctets(hostname);
    if (!octets) return true;
    const [first, second] = octets;
    const isLinkLocalMetadata = hostname === "169.254.169.254" || hostname === "169.254.170.2";
    const isMulticast = first >= 224 && first <= 239;
    const isUnspecified = first === 0 && octets.slice(1).every((part) => part === 0);
    const isCarrierMetadata = hostname === "100.100.100.200";
    return isLinkLocalMetadata || isCarrierMetadata || isMulticast || isUnspecified;
  }

  if (ipVersion === 6) {
    const compact = hostname.replace(/^0+:0+:0+:0+:0+:0+:0+:0+$/, "::");
    return compact === "::" || hostname.startsWith("ff");
  }

  return false;
}

/**
 * Validate a Mihomo Controller URL.
 * Private and loopback addresses are intentionally allowed; the controller
 * commonly lives on a router LAN. Credentials, query strings and fragments
 * are rejected so the secret cannot be smuggled through the URL.
 */
export function validateMihomoControllerUrl(controllerUrl) {
  if (typeof controllerUrl !== "string" || !controllerUrl.trim()) {
    throw new TypeError("Mihomo controllerUrl is required");
  }

  const raw = controllerUrl.trim();
  if (/[\u0000-\u0020]/.test(raw)) {
    throw new TypeError("Mihomo controllerUrl must not contain whitespace or control characters");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("Mihomo controllerUrl is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Mihomo controllerUrl must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Mihomo controllerUrl must not include credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError("Mihomo controllerUrl must not include query or fragment");
  }

  const hostname = normalizeHost(parsed.hostname);
  if (!hostname || DISALLOWED_HOSTNAMES.has(hostname) || isDisallowedIp(hostname)) {
    throw new TypeError("Mihomo controllerUrl targets a disallowed host");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function responseText(response) {
  return typeof response?.text === "function" ? response.text() : Promise.resolve("");
}

export class MihomoClientError extends Error {
  constructor(code, message, { status = null, cause = null, path = null } = {}) {
    super(message, { cause: cause || undefined });
    this.name = "MihomoClientError";
    this.code = code;
    this.status = status;
    this.path = path;
  }
}

function errorForStatus(response, path, bodyText) {
  if (response.status === 401 || response.status === 403) {
    return new MihomoClientError(
      MIHOMO_ERROR_CODES.UNAUTHORIZED,
      "Mihomo Controller authorization failed",
      { status: response.status, path },
    );
  }
  if (response.status === 404 && path.startsWith("/proxies/")) {
    return new MihomoClientError(
      MIHOMO_ERROR_CODES.SELECTOR_NOT_FOUND,
      "Mihomo proxy or selector was not found",
      { status: response.status, path },
    );
  }
  if (response.status === 404 && path.startsWith("/providers/proxies/")) {
    return new MihomoClientError(
      MIHOMO_ERROR_CODES.PROVIDER_NOT_FOUND,
      "Mihomo proxy provider was not found",
      { status: response.status, path },
    );
  }

  const suffix = bodyText ? `: ${bodyText.slice(0, 200)}` : "";
  return new MihomoClientError(
    MIHOMO_ERROR_CODES.INVALID_RESPONSE,
    `Mihomo Controller returned HTTP ${response.status}${suffix}`,
    { status: response.status, path },
  );
}

export function createMihomoClient({ controllerUrl, secret = "", timeoutMs } = {}) {
  const baseUrl = validateMihomoControllerUrl(controllerUrl);
  const controllerSecret = typeof secret === "string" ? secret : String(secret || "");
  const requestTimeoutMs = normalizeTimeoutMs(timeoutMs);

  function buildUrl(path) {
    const normalizedPath = String(path || "").replace(/^\/+/, "");
    return new URL(normalizedPath, `${baseUrl}/`).toString();
  }

  async function request(path, { method = "GET", body, expectedEmpty = false } = {}) {
    const url = buildUrl(path);
    const headers = { Accept: "application/json" };
    if (controllerSecret) headers.Authorization = `Bearer ${controllerSecret}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    let response;
    try {
      response = await globalThis.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError" || controller.signal.aborted;
      throw new MihomoClientError(
        timedOut ? MIHOMO_ERROR_CODES.TIMEOUT : MIHOMO_ERROR_CODES.UNREACHABLE,
        timedOut ? "Mihomo Controller request timed out" : "Mihomo Controller is unreachable",
        { cause: error, path },
      );
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await responseText(response);
    if (!response.ok) throw errorForStatus(response, path, bodyText);
    if (expectedEmpty || !bodyText) return null;

    try {
      return JSON.parse(bodyText);
    } catch (error) {
      throw new MihomoClientError(
        MIHOMO_ERROR_CODES.INVALID_RESPONSE,
        "Mihomo Controller returned invalid JSON",
        { cause: error, status: response.status, path },
      );
    }
  }

  return Object.freeze({
    getVersion: () => request("/version"),
    getProxies: () => request("/proxies"),
    getProxy: (name) => request(`/proxies/${encodePathSegment(name)}`),
    selectProxy: (selectorName, nodeName) => request(`/proxies/${encodePathSegment(selectorName)}`, {
      method: "PUT",
      body: { name: nodeName },
      expectedEmpty: true,
    }),
    getProxyProviders: () => request("/providers/proxies"),
    getProxyProvider: (providerName) => request(`/providers/proxies/${encodePathSegment(providerName)}`),
    healthCheckProvider: (providerName, { url, timeoutMs: healthTimeoutMs } = {}) => {
      const params = new URLSearchParams();
      if (url) params.set("url", url);
      if (healthTimeoutMs) params.set("timeout", String(healthTimeoutMs));
      const query = params.toString();
      return request(`/providers/proxies/${encodePathSegment(providerName)}/healthcheck${query ? `?${query}` : ""}`);
    },
    getConnections: () => request("/connections"),
    closeConnection: (id) => request(`/connections/${encodePathSegment(id)}`, { method: "DELETE", expectedEmpty: true }),
  });
}
