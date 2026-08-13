import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMihomoRotationState,
  prepareMihomoRouteAttempt,
} from "../../src/lib/network/mihomoRouteManager.js";
import { clearMihomoNodeDirectoryCache } from "../../src/lib/network/mihomoState.js";

function makePool(id = "pool-route") {
  return {
    id,
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:17891",
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
      selectorName: "selector",
      providerNames: ["subscription"],
      maxAttemptsPerRequest: 6,
      syncTtlMs: 30000,
      regionOrder: ["TW", "JP", "US", "SG", "HK", "OTHER"],
    },
    mihomoState: { proxyProviders: {} },
  };
}

function clientFor(nodes) {
  const proxies = Object.fromEntries(nodes.map((node) => [node.name, { type: "VLESS", alive: node.alive !== false }]));
  return {
    getProxy: async () => ({ type: "Selector", now: nodes[0]?.name || null, all: nodes.map((node) => node.name) }),
    getProxies: async () => ({ proxies }),
    getProxyProvider: async () => ({ name: "subscription", type: "HTTP", proxies: nodes.map((node) => ({ name: node.name, type: "VLESS" })) }),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  clearMihomoRotationState();
  clearMihomoNodeDirectoryCache();
});

describe("Mihomo route candidate selection", () => {
  it("deprioritizes a rate-limited region for the remainder of one request", async () => {
    const pool = makePool();
    const nodes = [
      { name: "TW-A30" },
      { name: "TW-A29" },
      { name: "JP-A01" },
      { name: "US-B01" },
    ];
    const context = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const getPool = async () => pool;
    const makeClient = () => clientFor(nodes);

    const first = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool, makeClient, nowMs: 100 });
    context.deprioritizedRegions.add(first.route.region);
    const second = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool, makeClient, nowMs: 200 });
    expect(first.route.region).toBe("TW");
    expect(second.route.region).toBe("JP");
    expect(second.route.nodeName).toBe("JP-A01");
  });

  it("allows a deprioritized region only when other regions have no eligible nodes", async () => {
    const pool = makePool("pool-fallback-region");
    pool.mihomoState.proxyProviders.subscription = {
      nodes: { "JP-A01": { business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString(), backoffLevel: 1 } } } },
    };
    const nodes = [{ name: "TW-A30" }, { name: "TW-A29" }, { name: "JP-A01" }];
    const context = {
      attemptedNodeKeys: new Set(["subscription\0TW-A30"]),
      deprioritizedRegions: new Set(["TW"]),
      attempts: 1,
      maxAttempts: 3,
    };
    const result = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool: async () => pool, makeClient: () => clientFor(nodes), nowMs: 100 });
    expect(result.route).toMatchObject({ nodeName: "TW-A29", region: "TW" });
  });

  it("never repeats a node and enforces max attempts", async () => {
    const pool = makePool("pool-max");
    const nodes = Array.from({ length: 8 }, (_, index) => ({ name: `JP-A${String(index).padStart(2, "0")}` }));
    const context = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const routes = [];
    for (let index = 0; index < 7; index += 1) {
      const prepared = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool: async () => pool, makeClient: () => clientFor(nodes), nowMs: 100 + index });
      if (prepared.route) routes.push(prepared.route.nodeName);
    }
    expect(routes).toHaveLength(6);
    expect(new Set(routes).size).toBe(6);
    expect(context.attempts).toBe(6);
  });

  it("uses a process-local node cursor across fresh requests", async () => {
    const pool = makePool("pool-fairness");
    const nodes = [{ name: "JP-A01" }, { name: "JP-A02" }];
    const firstContext = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const secondContext = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const options = { poolId: pool.id, businessProviderId: "opencode", getPool: async () => pool, makeClient: () => clientFor(nodes) };
    const first = await prepareMihomoRouteAttempt({ ...options, routeContext: firstContext, nowMs: 100 });
    await tick();
    const second = await prepareMihomoRouteAttempt({ ...options, routeContext: secondContext, nowMs: 200 });
    expect(second.route.nodeName).not.toBe(first.route.nodeName);
  });

  it("keeps regionOrder as priority across fresh requests", async () => {
    const pool = makePool("pool-region-priority");
    const nodes = [{ name: "TW-A01" }, { name: "TW-A02" }, { name: "JP-A01" }];
    const options = {
      poolId: pool.id,
      businessProviderId: "opencode",
      getPool: async () => pool,
      makeClient: () => clientFor(nodes),
    };
    const firstContext = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const secondContext = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };

    const first = await prepareMihomoRouteAttempt({ ...options, routeContext: firstContext, nowMs: 100 });
    const second = await prepareMihomoRouteAttempt({ ...options, routeContext: secondContext, nowMs: 200 });

    expect(first.route.region).toBe("TW");
    expect(second.route.region).toBe("TW");
    expect(second.route.nodeName).not.toBe(first.route.nodeName);
  });

  it("keeps node routing unchanged while exposing a distinct-egress shadow candidate", async () => {
    const pool = makePool("pool-shadow");
    const nodes = [{ name: "JP-A01" }, { name: "JP-A02" }];
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "JP-A01": { egress: { ip: "1.2.3.5", family: 4, identityKey: "4:1.2.3.5", confidence: "stable", expiresAt: 9999999999999 } },
        "JP-A02": { egress: { ip: "1.2.3.4", family: 4, identityKey: "4:1.2.3.4", confidence: "stable", expiresAt: 9999999999999 } },
      },
    };
    const context = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: context,
      getPool: async () => pool,
      makeClient: () => clientFor(nodes),
      nowMs: 100,
    });

    expect(result.route.nodeName).toBe("JP-A01");
    expect(result.route.egressIdentityKey).toBe("4:1.2.3.5");
    expect(result.shadowRoute).toMatchObject({ nodeName: "JP-A02", egressIdentityKey: "4:1.2.3.4" });
    expect(context.attemptedEgressKeys).toEqual(new Set());
  });

  it("freezes the stable/fresh egress scope decision at attempt start", async () => {
    const pool = makePool("pool-attempt-snapshot");
    pool.mihomo.egressScopedCooldown = true;
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "JP-A01": {
          egress: {
            ip: "1.2.3.5",
            family: 4,
            identityKey: "4:1.2.3.5",
            confidence: "stable",
            observedAt: 50,
            expiresAt: 1000,
          },
        },
      },
    };
    const context = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: context,
      getPool: async () => pool,
      makeClient: () => clientFor([{ name: "JP-A01" }]),
      nowMs: 100,
    });

    expect(result.route.egressSnapshot).toEqual({
      startedAtMs: 100,
      identityKey: "4:1.2.3.5",
      confidence: "stable",
      observedAt: 50,
      expiresAt: 1000,
      scopeEligible: true,
    });
    expect(Object.isFrozen(result.route.egressSnapshot)).toBe(true);

    pool.mihomoState.proxyProviders.subscription.nodes["JP-A01"].egress = {
      ip: "9.9.9.9",
      family: 4,
      identityKey: "4:9.9.9.9",
      confidence: "stable",
      observedAt: 101,
      expiresAt: 2000,
    };
    expect(result.route.egressSnapshot.identityKey).toBe("4:1.2.3.5");
    expect(result.route.egressSnapshot.scopeEligible).toBe(true);
  });

  it.each([
    ["tentative", { confidence: "tentative", expiresAt: 1000 }, true],
    ["stale", { confidence: "stable", expiresAt: 99 }, true],
    ["feature-disabled", { confidence: "stable", expiresAt: 1000 }, false],
  ])("does not make a %s mapping eligible for egress scope", async (_caseName, egress, egressScopedCooldown) => {
    const pool = makePool(`pool-attempt-snapshot-${_caseName}`);
    pool.mihomo.egressScopedCooldown = egressScopedCooldown;
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "JP-A01": {
          egress: {
            ip: "1.2.3.5",
            family: 4,
            identityKey: "4:1.2.3.5",
            observedAt: 50,
            ...egress,
          },
        },
      },
    };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 },
      getPool: async () => pool,
      makeClient: () => clientFor([{ name: "JP-A01" }]),
      nowMs: 100,
    });

    expect(result.route.egressSnapshot).toMatchObject({
      identityKey: "4:1.2.3.5",
      confidence: egress.confidence,
      scopeEligible: false,
    });
  });
});
