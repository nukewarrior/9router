import { describe, expect, it, vi } from "vitest";
import {
  classifyRateLimitError,
  isIpCandidateRateLimitError,
  isRateLimitError,
} from "../../open-sse/services/errorClassification.js";
import { parseRetryAfter, parseUpstreamError } from "../../open-sse/utils/error.js";

describe("rate limit classification", () => {
  it("recognizes status and known business markers", () => {
    expect(isRateLimitError(429, "anything")).toBe(true);
    expect(isRateLimitError(500, "capacity temporarily unavailable")).toBe(true);
    expect(isIpCandidateRateLimitError(500, "FreeUsageLimitError from Console")).toBe(true);
    expect(isIpCandidateRateLimitError(500, "provider overloaded")).toBe(false);
    expect(classifyRateLimitError(500, "FreeUsageLimitError: try later")).toBe("FreeUsageLimitError");
  });
});

describe("Retry-After parsing", () => {
  it("parses delta seconds and HTTP dates", () => {
    const now = 1700000000000;
    expect(parseRetryAfter("600", now)).toBe(now + 600000);
    expect(parseRetryAfter("0.5", now)).toBe(now + 500);
    expect(parseRetryAfter(new Date(now + 900000).toUTCString(), now)).toBe(now + 900000);
    expect(parseRetryAfter("not valid", now)).toBeNull();
  });

  it("prefers executor resetsAtMs over Retry-After", async () => {
    const response = new Response(JSON.stringify({ error: { message: "limited" } }), {
      status: 429,
      headers: { "Retry-After": "600", "content-type": "application/json" },
    });
    const parsed = await parseUpstreamError(response, {
      parseError: vi.fn(() => ({ status: 429, message: "provider limited", resetsAtMs: 1700000001234 })),
    });
    expect(parsed).toMatchObject({ statusCode: 429, message: "provider limited", resetsAtMs: 1700000001234 });
  });

  it("uses Retry-After when executor has no precise reset", async () => {
    const now = Date.now();
    const response = new Response(JSON.stringify({ error: { message: "limited" } }), {
      status: 429,
      headers: { "Retry-After": "3" },
    });
    const parsed = await parseUpstreamError(response);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(now + 2900);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(now + 3100);
  });
});
