import { describe, it, expect, vi, beforeEach } from "vitest";

const getProxyPoolById = vi.fn();

vi.mock("@/models", () => ({ getProxyPoolById }));

const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");

beforeEach(() => getProxyPoolById.mockReset());

describe("resolveConnectionProxyConfig strict semantics", () => {
  it("forces strict mode for Mihomo pools", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "mihomo-pool",
      type: "mihomo",
      proxyUrl: "http://router:17891",
      isActive: true,
      strictProxy: false,
    });

    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: "mihomo-pool" });

    expect(resolved.connectionProxyEnabled).toBe(true);
    expect(resolved.strictProxy).toBe(true);
  });

  it("preserves strict mode for ordinary pools when configured", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "http-pool",
      type: "http",
      proxyUrl: "http://proxy:8080",
      isActive: true,
      strictProxy: true,
    });

    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: "http-pool" });

    expect(resolved.strictProxy).toBe(true);
  });
});
