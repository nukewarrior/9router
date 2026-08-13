import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMihomoEgressCooldown,
  getMihomoEgressBusinessState,
  getMihomoNodeBusinessState,
  recordMihomoRouteFailure,
  recordMihomoRouteSuccess,
} from "../../src/lib/network/mihomoState.js";
import {
  clearMihomoRotationState,
  prepareMihomoRouteAttempt,
} from "../../src/lib/network/mihomoRouteManager.js";
import { clearMihomoNodeDirectoryCache } from "../../src/lib/network/mihomoState.js";

function makePool() {
  return {
    id: "egress-cooldown",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:17892",
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
      selectorName: "selector",
      providerNames: ["subscription"],
      egressScopedCooldown: true,
      preferDistinctEgress: true,
      cooldown: { baseMs: 300000, multiplier: 3, maxMs: 1800000 },
    },
    mihomoState: { proxyProviders: {}, egressIdentities: {} },
  };
}

function stableEgress(identityKey, expiresAt = 9999999999999, confidence = "stable") {
  return {
    ip: identityKey.slice(2),
    family: identityKey.startsWith("6:") ? 6 : 4,
    identityKey,
    confidence,
    sampleCount: 2,
    successfulSamples: 2,
    observedAt: 100,
    expiresAt,
    lastProbeAt: 100,
    lastProbeError: null,
  };
}

function setNode(pool, nodeName, egress) {
  pool.mihomoState.proxyProviders.subscription ||= { nodes: {} };
  pool.mihomoState.proxyProviders.subscription.nodes[nodeName] = { egress };
}

function mutatorFor(pool, writes = null) {
  return async (_id, mutator) => {
    if (writes) writes.count += 1;
    return mutator(pool);
  };
}

function makeClient(nodes) {
  return {
    getProxy: async () => ({ type: "Selector", now: nodes[0], all: nodes }),
    getProxies: async () => ({ proxies: Object.fromEntries(nodes.map((node) => [node, { type: "VLESS", alive: true }])) }),
    getProxyProvider: async () => ({ proxies: nodes.map((name) => ({ name, type: "VLESS" })) }),
  };
}

beforeEach(() => {
  clearMihomoRotationState();
  clearMihomoNodeDirectoryCache();
});

describe("Mihomo egress-scoped business cooldown", () => {
  it("writes stable/fresh rate limits to identity/provider state", async () => {
    const pool = makePool();
    setNode(pool, "TW-A10", stableEgress("4:61.219.114.43"));
    const route = { proxyProvider: "subscription", nodeName: "TW-A10" };
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });

    expect(result).toMatchObject({ updated: true, scope: "egress", identityKey: "4:61.219.114.43", cooldownMs: 300000 });
    expect(getMihomoEgressBusinessState(pool, "4:61.219.114.43", "opencode")).toMatchObject({ backoffLevel: 1, lastStatus: 429 });
    expect(getMihomoNodeBusinessState(pool, route, "opencode").cooldownUntil).toBeNull();
  });

  it("keeps node-scoped semantics when the egress cooldown flag is disabled", async () => {
    const pool = makePool();
    pool.mihomo.egressScopedCooldown = false;
    setNode(pool, "TW-A10", stableEgress("4:61.219.114.43"));
    const route = { proxyProvider: "subscription", nodeName: "TW-A10" };
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });
    expect(result.scope).toBe("node");
    expect(getMihomoNodeBusinessState(pool, route, "opencode").backoffLevel).toBe(1);
    expect(pool.mihomoState.egressIdentities).toEqual({});
  });

  it("excludes all same-IP siblings while keeping another IP available", async () => {
    const pool = makePool();
    const nodes = ["TW-A10", "TW-A11", "TW-A20"];
    setNode(pool, "TW-A10", stableEgress("4:61.219.114.43"));
    setNode(pool, "TW-A11", stableEgress("4:61.219.114.43"));
    setNode(pool, "TW-A20", stableEgress("4:211.23.142.61"));
    pool.mihomoState.egressIdentities["4:61.219.114.43"] = {
      business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString(), backoffLevel: 1 } },
    };
    const context = { attemptedNodeKeys: new Set(), attemptedEgressKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: context,
      getPool: async () => pool,
      makeClient: () => makeClient(nodes),
      nowMs: 1000,
    });

    expect(result.route).toMatchObject({ nodeName: "TW-A20", egressIdentityKey: "4:211.23.142.61" });
  });

  it("isolates cooldown by business provider", async () => {
    const pool = makePool();
    const nodes = ["TW-A10", "TW-A20"];
    setNode(pool, "TW-A10", stableEgress("4:61.219.114.43"));
    setNode(pool, "TW-A20", stableEgress("4:211.23.142.61"));
    pool.mihomoState.egressIdentities["4:61.219.114.43"] = {
      business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString() } },
    };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "gemini",
      routeContext: { attemptedNodeKeys: new Set(), attemptedEgressKeys: new Set(["4:211.23.142.61"]), deprioritizedRegions: new Set(), attempts: 0 },
      getPool: async () => pool,
      makeClient: () => makeClient(nodes),
      nowMs: 1000,
    });
    expect(result.route.nodeName).toBe("TW-A10");
  });

  it("falls back to node cooldown for stale, dynamic and unknown mappings", async () => {
    for (const egress of [
      stableEgress("4:1.2.3.4", 999),
      { ...stableEgress("4:1.2.3.4"), confidence: "dynamic" },
      null,
    ]) {
      const pool = makePool();
      setNode(pool, "TW-A10", egress);
      const route = { proxyProvider: "subscription", nodeName: "TW-A10" };
      const result = await recordMihomoRouteFailure({
        proxyPoolId: pool.id,
        route,
        businessProviderId: "opencode",
        status: 500,
        error: "FreeUsageLimitError",
        mutatePool: mutatorFor(pool),
        nowMs: 1000,
      });
      expect(result.scope).toBe("node");
      expect(getMihomoNodeBusinessState(pool, route, "opencode").cooldownUntil).toBe("1970-01-01T00:05:01.000Z");
      expect(getMihomoEgressBusinessState(pool, "4:1.2.3.4", "opencode").cooldownUntil).toBeNull();
      if (egress) expect(pool.mihomoState.proxyProviders.subscription.nodes["TW-A10"].egress.needsProbe).toBe(true);
    }
  });

  it("does not create egress cooldown for generic failures, and resets egress backoff on success", async () => {
    const pool = makePool();
    setNode(pool, "TW-A10", stableEgress("4:61.219.114.43"));
    const route = { proxyProvider: "subscription", nodeName: "TW-A10" };
    const generic = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 500,
      error: "upstream unavailable",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });
    expect(generic.updated).toBe(false);
    expect(pool.mihomoState.egressIdentities).toEqual({});

    await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 429, error: "429", mutatePool: mutatorFor(pool), nowMs: 1000 });
    const second = await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 429, error: "429", mutatePool: mutatorFor(pool), nowMs: 1000 });
    expect(second.cooldownMs).toBe(900000);
    const success = await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool: mutatorFor(pool), nowMs: 2000 });
    expect(success).toMatchObject({ updated: true, scope: "egress", identityKey: "4:61.219.114.43" });
    expect(getMihomoEgressBusinessState(pool, "4:61.219.114.43", "opencode")).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastSuccessAt: "1970-01-01T00:00:02.000Z" });
  });

  it("limits clean success writes to once per minute", async () => {
    const pool = makePool();
    setNode(pool, "TW-A10", stableEgress("4:61.219.114.43"));
    const writes = { count: 0 };
    const mutatePool = mutatorFor(pool, writes);
    const getPool = async () => pool;
    const route = { proxyProvider: "subscription", nodeName: "TW-A10" };

    await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool, getPool, nowMs: 1000 });
    await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool, getPool, nowMs: 2000 });
    await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool, getPool, nowMs: 62001 });
    expect(writes.count).toBe(2);
  });

  it("manually clears one identity/provider cooldown", async () => {
    const pool = makePool();
    pool.mihomoState.egressIdentities["4:61.219.114.43"] = {
      business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString(), backoffLevel: 4, lastError: "429" } },
    };
    const result = await clearMihomoEgressCooldown({
      proxyPoolId: pool.id,
      identityKey: "4:61.219.114.43",
      businessProviderId: "opencode",
      mutatePool: mutatorFor(pool),
    });
    expect(result.updated).toBe(true);
    expect(getMihomoEgressBusinessState(pool, "4:61.219.114.43", "opencode")).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastError: null });
  });
});
