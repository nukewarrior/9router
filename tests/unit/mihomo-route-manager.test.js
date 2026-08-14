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
    proxyUrl: "http://router:18080",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
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
      { name: "Example Taiwan Node A" },
      { name: "Example Taiwan Node B" },
      { name: "Example Japan Node A" },
      { name: "Example United States Node A" },
    ];
    const context = { attemptedNodeKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const getPool = async () => pool;
    const makeClient = () => clientFor(nodes);

    const first = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool, makeClient, nowMs: 100 });
    context.deprioritizedRegions.add(first.route.region);
    const second = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool, makeClient, nowMs: 200 });
    expect(first.route.region).toBe("TW");
    expect(second.route.region).toBe("JP");
    expect(second.route.nodeName).toBe("Example Japan Node A");
  });

  it("allows a deprioritized region only when other regions have no eligible nodes", async () => {
    const pool = makePool("pool-fallback-region");
    pool.mihomoState.proxyProviders.subscription = {
      nodes: { "Example Japan Node A": { business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString(), backoffLevel: 1 } } } },
    };
    const nodes = [{ name: "Example Taiwan Node A" }, { name: "Example Taiwan Node B" }, { name: "Example Japan Node A" }];
    const context = {
      attemptedNodeKeys: new Set(["subscription\0Example Taiwan Node A"]),
      deprioritizedRegions: new Set(["TW"]),
      attempts: 1,
      maxAttempts: 3,
    };
    const result = await prepareMihomoRouteAttempt({ poolId: pool.id, businessProviderId: "opencode", routeContext: context, getPool: async () => pool, makeClient: () => clientFor(nodes), nowMs: 100 });
    expect(result.route).toMatchObject({ nodeName: "Example Taiwan Node B", region: "TW" });
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
    const nodes = [{ name: "Example Japan Node A" }, { name: "Example Japan Node B" }];
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
    const nodes = [{ name: "Example Taiwan Node A" }, { name: "Example Taiwan Node B" }, { name: "Example Japan Node A" }];
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
    const nodes = [{ name: "Example Japan Node A" }, { name: "Example Japan Node B" }];
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "Example Japan Node A": { egress: { ip: "192.0.2.21", family: 4, identityKey: "4:192.0.2.21", confidence: "stable", expiresAt: 9999999999999 } },
        "Example Japan Node B": { egress: { ip: "192.0.2.20", family: 4, identityKey: "4:192.0.2.20", confidence: "stable", expiresAt: 9999999999999 } },
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

    expect(result.route.nodeName).toBe("Example Japan Node A");
    expect(result.route.egressIdentityKey).toBe("4:192.0.2.21");
    expect(result.shadowRoute).toMatchObject({ nodeName: "Example Japan Node B", egressIdentityKey: "4:192.0.2.20" });
    expect(context.attemptedEgressKeys).toEqual(new Set());
  });

  it("freezes the stable/fresh egress scope decision at attempt start", async () => {
    const pool = makePool("pool-attempt-snapshot");
    pool.mihomo.egressScopedCooldown = true;
    pool.mihomoState.proxyProviders.subscription = {
      nodes: {
        "Example Japan Node A": {
          egress: {
            ip: "192.0.2.21",
            family: 4,
            identityKey: "4:192.0.2.21",
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
      makeClient: () => clientFor([{ name: "Example Japan Node A" }]),
      nowMs: 100,
    });

    expect(result.route.egressSnapshot).toEqual({
      startedAtMs: 100,
      identityKey: "4:192.0.2.21",
      confidence: "stable",
      observedAt: 50,
      expiresAt: 1000,
      scopeEligible: true,
    });
    expect(Object.isFrozen(result.route.egressSnapshot)).toBe(true);

    pool.mihomoState.proxyProviders.subscription.nodes["Example Japan Node A"].egress = {
      ip: "203.0.113.31",
      family: 4,
      identityKey: "4:203.0.113.31",
      confidence: "stable",
      observedAt: 101,
      expiresAt: 2000,
    };
    expect(result.route.egressSnapshot.identityKey).toBe("4:192.0.2.21");
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
        "Example Japan Node A": {
          egress: {
            ip: "192.0.2.21",
            family: 4,
            identityKey: "4:192.0.2.21",
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
      makeClient: () => clientFor([{ name: "Example Japan Node A" }]),
      nowMs: 100,
    });

    expect(result.route.egressSnapshot).toMatchObject({
      identityKey: "4:192.0.2.21",
      confidence: egress.confidence,
      scopeEligible: false,
    });
  });
});
