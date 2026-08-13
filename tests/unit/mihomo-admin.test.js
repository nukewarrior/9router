import { beforeEach, describe, expect, it } from "vitest";
import {
  getMihomoNodeStatus,
  mihomoAdminErrorResponse,
  MihomoAdminError,
  testMihomoPool,
} from "../../src/lib/network/mihomoAdmin.js";
import { clearMihomoNodeDirectoryCache } from "../../src/lib/network/mihomoState.js";

function makePool() {
  return {
    id: "pool-admin",
    type: "mihomo",
    proxyUrl: "http://10.11.11.1:17891",
    isActive: true,
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
      controllerSecret: "top-secret",
      selectorName: "selector",
      providerNames: ["subscription"],
      syncTtlMs: 30000,
    },
    mihomoState: { proxyProviders: {} },
  };
}

function fakeClient() {
  const nodes = ["🇹🇼 TW-A30", "🇯🇵 JP-A01"];
  return {
    getVersion: async () => ({ version: "1.0.0" }),
    getProxy: async () => ({ type: "Selector", now: nodes[0], all: nodes }),
    getProxies: async () => Object.fromEntries(nodes.map((name) => [name, { type: "VLESS", alive: true, delay: 82 }])),
    getProxyProvider: async () => ({ proxies: nodes.map((name) => ({ name })) }),
  };
}

beforeEach(() => clearMihomoNodeDirectoryCache());

describe("Mihomo admin operations", () => {
  it("tests controller, provider leaf nodes and listener without returning the secret", async () => {
    const result = await testMihomoPool({
      pool: makePool(),
      makeClient: () => fakeClient(),
      testProxy: async () => ({ ok: true, status: 204, elapsedMs: 12 }),
    });

    expect(result).toMatchObject({
      ok: true,
      controller: { version: { version: "1.0.0" }, selector: { type: "Selector" } },
      listener: { ok: true, status: 204 },
    });
    expect(result.nodes).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("top-secret");
  });

  it("returns provider-scoped node state for the status table", async () => {
    const pool = makePool();
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "🇹🇼 TW-A30": {
          business: {
            opencode: {
              cooldownUntil: new Date(Date.now() + 60000).toISOString(),
              lastStatus: 429,
              lastErrorType: "HTTP_429",
            },
          },
        },
      },
    };
    const result = await getMihomoNodeStatus({ pool, makeClient: () => fakeClient() });
    expect(result.selector).toMatchObject({ name: "selector", now: "🇹🇼 TW-A30" });
    expect(result.nodes[0].providerState.opencode).toMatchObject({ status: "cooldown", lastStatus: 429 });
    expect(result.nodes[1].providerState.opencode.status).toBe("unknown");
  });

  it("maps invalid configuration to a client-safe 400 response", () => {
    const result = mihomoAdminErrorResponse(new MihomoAdminError("MIHOMO_INVALID_CONFIG", "Mihomo selectorName is required", 400));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "MIHOMO_INVALID_CONFIG" });
  });
});
