import { randomUUID } from "node:crypto";

const MAX_ID_LENGTH = 64;
const MAX_ERROR_TEXT_LENGTH = 500;
const MAX_ERROR_DEPTH = 4;
const DEBUG_ID_KEYS = [
  "x-request-id",
  "x-correlation-id",
  "x-client-request-id",
  "x-trace-id",
  "trace-id",
  "traceparent",
];
const DEBUG_BODY_ID_KEYS = ["requestId", "request_id", "completionId", "completion_id", "id"];
const SENSITIVE_TEXT_PATTERN = /(authorization|cookie|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z\d+.-]*:\/\/)([^/\s:@]+)(?::[^@\s/]+)?@/gi;

function text(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function truncate(value, maxLength = MAX_ERROR_TEXT_LENGTH) {
  const normalized = text(value).replace(/[\r\n]+/g, "\\n");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function redactText(value) {
  return truncate(value)
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SENSITIVE_TEXT_PATTERN, "$1=[redacted]");
}

function normalizeId(value) {
  const normalized = text(value).trim();
  if (!normalized) return null;
  const safe = normalized.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, MAX_ID_LENGTH);
  return safe || null;
}

function readHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  if (typeof headers === "object") {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
  }
  return "";
}

export function isMihomoDebugEnabled() {
  return text(process.env.MIHOMO_DEBUG).trim().toLowerCase() === "true";
}

export function createMihomoDebugId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Prefer a request identifier already attached to the inbound request. The
 * fallback is intentionally accepted so retry attempts can share one ID.
 */
export function resolveMihomoRequestId({ request = null, clientRawRequest = null, body = null, fallback = null } = {}) {
  const headers = clientRawRequest?.headers || request?.headers;
  for (const key of DEBUG_ID_KEYS) {
    const value = normalizeId(readHeader(headers, key));
    if (value) return value;
  }

  for (const key of DEBUG_BODY_ID_KEYS) {
    const value = normalizeId(body?.[key]);
    if (value) return value;
  }

  return normalizeId(fallback) || createMihomoDebugId();
}

export function createMihomoDebugContext({ requestId, routeId, attempt, maxAttempts } = {}) {
  return {
    requestId: normalizeId(requestId),
    routeId: normalizeId(routeId),
    attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : null,
    maxAttempts: Number.isFinite(Number(maxAttempts)) ? Number(maxAttempts) : null,
  };
}

export function sanitizeProxyUrl(proxyUrl) {
  const raw = text(proxyUrl).trim();
  if (!raw) return "unknown";

  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname}${port}`;
  } catch {
    return "invalid";
  }
}

export function sanitizeTarget(targetUrl) {
  try {
    const parsed = new URL(text(targetUrl));
    const defaultPort = parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
    return {
      protocol: parsed.protocol.replace(/:$/, ""),
      hostname: parsed.hostname,
      port: parsed.port || defaultPort || "unknown",
      authority: `${parsed.hostname}:${parsed.port || defaultPort || "unknown"}`,
    };
  } catch {
    return { protocol: "unknown", hostname: "unknown", port: "unknown", authority: "unknown" };
  }
}

function errorFieldValue(value) {
  if (value === undefined || value === null || value === "") return null;
  return redactText(value);
}

function errorSnapshot(error) {
  if (error instanceof Error) {
    return {
      name: errorFieldValue(error.name) || "Error",
      message: errorFieldValue(error.message) || "",
      code: errorFieldValue(error.code),
      errno: errorFieldValue(error.errno),
      syscall: errorFieldValue(error.syscall),
      address: errorFieldValue(error.address),
      port: errorFieldValue(error.port),
      hostname: errorFieldValue(error.hostname),
      cause: error.cause,
    };
  }

  if (typeof error === "string") {
    return { name: "Error", message: errorFieldValue(error) || "", cause: undefined };
  }

  if (error && typeof error === "object") {
    return {
      name: errorFieldValue(error.name) || "Error",
      message: errorFieldValue(error.message) || "",
      code: errorFieldValue(error.code),
      errno: errorFieldValue(error.errno),
      syscall: errorFieldValue(error.syscall),
      address: errorFieldValue(error.address),
      port: errorFieldValue(error.port),
      hostname: errorFieldValue(error.hostname),
      cause: error.cause,
    };
  }

  return { name: "Error", message: errorFieldValue(error) || "", cause: undefined };
}

/** Serialize only safe, diagnostic Error fields and cap cause traversal. */
export function serializeMihomoError(error, maxDepth = MAX_ERROR_DEPTH) {
  const chain = [];
  const seen = new Set();
  let current = error;

  while (current !== undefined && current !== null && chain.length < Math.max(1, Math.min(Number(maxDepth) || MAX_ERROR_DEPTH, MAX_ERROR_DEPTH))) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) break;
    if (typeof current === "object" || typeof current === "function") seen.add(current);

    const snapshot = errorSnapshot(current);
    const { cause, ...safeSnapshot } = snapshot;
    chain.push(Object.fromEntries(Object.entries(safeSnapshot).filter(([, value]) => value !== null)));
    current = cause;
  }

  return chain;
}

export function mihomoErrorFields(error, prefix = "error") {
  const fields = {};
  serializeMihomoError(error).forEach((entry, index) => {
    const root = index === 0 ? prefix : `${prefix}[${index}]`;
    for (const [key, value] of Object.entries(entry)) fields[`${root}.${key}`] = value;
  });
  return fields;
}

function formatContext(context = {}) {
  const parts = [];
  const requestId = normalizeId(context.requestId);
  const routeId = normalizeId(context.routeId);
  if (requestId) parts.push(`[req=${requestId}]`);
  if (routeId) parts.push(`[route=${routeId}]`);
  const attempt = Number(context.attempt);
  if (Number.isFinite(attempt)) {
    const maxAttempts = Number(context.maxAttempts);
    parts.push(`[attempt=${attempt}/${Number.isFinite(maxAttempts) ? maxAttempts : "?"}]`);
  }
  return parts.join("");
}

function formatValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(redactText(value));
  return "[object]";
}

function emit(channel, tag, context, fields) {
  if (!isMihomoDebugEnabled()) return;
  const safeTag = text(tag).replace(/[\r\n]+/g, " ").trim() || "debug";
  const fieldText = Object.entries(fields || {})
    .filter(([key, value]) => value !== undefined && value !== null && !/(authorization|cookie|api[-_ ]?key|token|secret|password|body|prompt|messagecontent)/i.test(key))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  console.log(`[${channel}]${formatContext(context)} ${safeTag}${fieldText ? ` ${fieldText}` : ""}`);
}

export function mihomoDebug(tag, context = {}, fields = {}) {
  emit("MIHOMO", tag, context, fields);
}

export function proxyDebug(tag, context = {}, fields = {}) {
  emit("PROXY", tag, context, fields);
}
