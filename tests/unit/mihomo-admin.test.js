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
    mihomoState: { proxyProviders: {}, egressIdentities: {} },
  };
}

function fakeClient() {
  const nodes = ["🇹🇼 TW-A30", "🇯🇵 JP-A01"];
  return {
    getVersion: async () => ({ version: "1.0.0" }),
    getProxy: async () => ({ type: "Selector", now: nodes[0], all: nodes }),
    getProxies: async () => ({
      proxies: Object.fromEntries(nodes.map((name) => [name, { type: "VLESS", alive: true, history: [{ delay: 82 }] }])),
    }),
    getProxyProvider: async () => ({ name: "subscription", type: "HTTP", proxies: nodes.map((name) => ({ name, type: "VLESS" })) }),
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
          egress: {
            ip: "61.219.114.43",
            family: 4,
            identityKey: "4:61.219.114.43",
            confidence: "stable",
            sampleCount: 2,
            successfulSamples: 2,
            observedAt: Date.now(),
            expiresAt: Date.now() + 60000,
          },
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
    pool.mihomoState.egressIdentities["4:61.219.114.43"] = {
      business: { opencode: { cooldownUntil: new Date(Date.now() + 60000).toISOString(), backoffLevel: 1 } },
    };
    const result = await getMihomoNodeStatus({ pool, makeClient: () => fakeClient() });
    expect(result.selector).toMatchObject({ name: "selector", now: "🇹🇼 TW-A30" });
    expect(result.nodes[0].providerState.opencode).toMatchObject({ status: "cooldown", lastStatus: 429 });
    expect(result.nodes[0]).toMatchObject({
      exitIp: "61.219.114.43",
      exitIpFamily: 4,
      exitIdentityKey: "4:61.219.114.43",
      exitConfidence: "stable",
      exitFresh: true,
      exitGroupSize: 1,
      exitCooldownUntil: expect.any(String),
    });
    expect(result.nodes[1].providerState.opencode.status).toBe("unknown");
    expect(result.summary).toMatchObject({ leafNodes: 2, probedNodes: 1, freshStableMappings: 1, distinctExitIps: 1 });
  });

  it("reports egress cooldown as the effective status only when enabled and fresh", async () => {
    const pool = makePool();
    pool.mihomo.egressScopedCooldown = true;
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "🇹🇼 TW-A30": {
          egress: {
            ip: "61.219.114.43",
            family: 4,
            identityKey: "4:61.219.114.43",
            confidence: "stable",
            observedAt: 100,
            expiresAt: 1000000,
          },
          business: { opencode: { lastSuccessAt: new Date(100).toISOString() } },
        },
      },
    };
    pool.mihomoState.egressIdentities["4:61.219.114.43"] = {
      business: { opencode: { cooldownUntil: new Date(500000).toISOString() } },
    };

    const result = await getMihomoNodeStatus({ pool, makeClient: () => fakeClient(), nowMs: 1000 });
    expect(result.nodes[0]).toMatchObject({
      effectiveStatus: "cooldown",
      cooldownScope: "egress",
      effectiveCooldownUntil: "1970-01-01T00:08:20.000Z",
      providerState: { opencode: { status: "cooldown", cooldownScope: "egress", nodeCooldownUntil: null } },
    });

    pool.mihomo.egressScopedCooldown = false;
    const disabled = await getMihomoNodeStatus({ pool, makeClient: () => fakeClient(), nowMs: 1000 });
    expect(disabled.nodes[0]).toMatchObject({ effectiveStatus: "healthy", cooldownScope: null, effectiveCooldownUntil: null });
  });

  it("maps invalid configuration to a client-safe 400 response", () => {
    const result = mihomoAdminErrorResponse(new MihomoAdminError("MIHOMO_INVALID_CONFIG", "Mihomo selectorName is required", 400));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "MIHOMO_INVALID_CONFIG" });
  });
});
