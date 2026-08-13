import { ERROR_RULES } from "../config/errorConfig.js";

const RATE_LIMIT_RULE_TEXT = new Set(
  ERROR_RULES.filter((rule) => rule.backoff && rule.text).map((rule) => rule.text.toLowerCase()),
);

const NODE_RATE_LIMIT_MARKERS = new Set([
  ...["rate limit", "too many requests", "quota exceeded"].filter((marker) => RATE_LIMIT_RULE_TEXT.has(marker)),
  "freeusagelimiterror",
]);

export function normalizeErrorText(errorText) {
  if (errorText === undefined || errorText === null) return "";
  if (typeof errorText === "string") return errorText.toLowerCase();
  try { return JSON.stringify(errorText).toLowerCase(); } catch { return String(errorText).toLowerCase(); }
}

function hasMarker(text, markers) {
  return [...markers].some((marker) => text.includes(marker));
}

/** Broad provider rate/capacity classification, derived from account fallback rules. */
export function isRateLimitError(status, errorText) {
  const numericStatus = Number(status);
  const normalized = normalizeErrorText(errorText);
  return numericStatus === 429 || hasMarker(normalized, RATE_LIMIT_RULE_TEXT);
}

/**
 * Conservative node/IP candidate classification. Capacity and overloaded are
 * intentionally excluded because they may represent provider-wide pressure.
 */
export function isIpCandidateRateLimitError(status, errorText) {
  const numericStatus = Number(status);
  const normalized = normalizeErrorText(errorText);
  return numericStatus === 429 || hasMarker(normalized, NODE_RATE_LIMIT_MARKERS);
}

export const isNodeRateLimitCandidate = isIpCandidateRateLimitError;

export function classifyRateLimitError(status, errorText) {
  const normalized = normalizeErrorText(errorText);
  if (normalized.includes("freeusagelimiterror")) return "FreeUsageLimitError";
  if (Number(status) === 429) return "HTTP_429";
  if (normalized.includes("rate limit")) return "RateLimitError";
  if (normalized.includes("too many requests")) return "TooManyRequests";
  if (normalized.includes("quota exceeded")) return "QuotaExceeded";
  return null;
}
