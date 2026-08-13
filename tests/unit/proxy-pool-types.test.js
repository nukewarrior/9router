import { describe, it, expect } from "vitest";
import {
  PROXY_POOL_TYPES,
  isMihomoProxyPool,
  isRelayProxyPoolType,
  normalizeProxyPoolType,
} from "../../src/lib/network/proxyPoolTypes.js";

describe("proxy pool types", () => {
  it("uses one shared type contract", () => {
    expect(PROXY_POOL_TYPES.has("http")).toBe(true);
    expect(PROXY_POOL_TYPES.has("deno")).toBe(true);
    expect(PROXY_POOL_TYPES.has("mihomo")).toBe(true);
    expect(normalizeProxyPoolType("unknown")).toBe("http");
  });

  it("distinguishes relay and managed Mihomo pools", () => {
    expect(isRelayProxyPoolType({ type: "cloudflare" })).toBe(true);
    expect(isMihomoProxyPool({ type: "mihomo" })).toBe(true);
    expect(isRelayProxyPoolType("mihomo")).toBe(false);
  });
});
