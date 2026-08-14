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
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
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

function routeFor(identityKey = "4:198.51.100.20", { scopeEligible = true, startedAtMs = 1000, confidence = "stable" } = {}) {
  return {
    proxyProvider: "subscription",
    nodeName: "Example Taiwan Node A",
    attemptStartedAtMs: startedAtMs,
    egressSnapshot: {
      startedAtMs,
      identityKey,
      confidence,
      observedAt: 100,
      expiresAt: 9999999999999,
      scopeEligible,
    },
  };
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
    setNode(pool, "Example Taiwan Node A", stableEgress("4:198.51.100.20"));
    const route = routeFor();
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });

    expect(result).toMatchObject({ updated: true, scope: "egress", identityKey: "4:198.51.100.20", cooldownMs: 300000 });
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toMatchObject({ backoffLevel: 1, lastStatus: 429 });
    expect(getMihomoNodeBusinessState(pool, route, "opencode").cooldownUntil).toBeNull();
  });

  it("keeps node-scoped semantics when the egress cooldown flag is disabled", async () => {
    const pool = makePool();
    pool.mihomo.egressScopedCooldown = false;
    setNode(pool, "Example Taiwan Node A", stableEgress("4:198.51.100.20"));
    const route = routeFor();
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
    const nodes = ["Example Taiwan Node A", "Example Taiwan Node B", "Example Taiwan Node C"];
    setNode(pool, "Example Taiwan Node A", stableEgress("4:198.51.100.20"));
    setNode(pool, "Example Taiwan Node B", stableEgress("4:198.51.100.20"));
    setNode(pool, "Example Taiwan Node C", stableEgress("4:203.0.113.30"));
    pool.mihomoState.egressIdentities["4:198.51.100.20"] = {
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

    expect(result.route).toMatchObject({ nodeName: "Example Taiwan Node C", egressIdentityKey: "4:203.0.113.30" });
  });

  it("isolates cooldown by business provider", async () => {
    const pool = makePool();
    const nodes = ["Example Taiwan Node A", "Example Taiwan Node C"];
    setNode(pool, "Example Taiwan Node A", stableEgress("4:198.51.100.20"));
    setNode(pool, "Example Taiwan Node C", stableEgress("4:203.0.113.30"));
    pool.mihomoState.egressIdentities["4:198.51.100.20"] = {
      business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString() } },
    };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "gemini",
      routeContext: { attemptedNodeKeys: new Set(), attemptedEgressKeys: new Set(["4:203.0.113.30"]), deprioritizedRegions: new Set(), attempts: 0 },
      getPool: async () => pool,
      makeClient: () => makeClient(nodes),
      nowMs: 1000,
    });
    expect(result.route.nodeName).toBe("Example Taiwan Node A");
  });

  it("falls back to node cooldown for stale, dynamic and unknown mappings", async () => {
    for (const egress of [
      stableEgress("4:192.0.2.20", 999),
      { ...stableEgress("4:192.0.2.20"), confidence: "dynamic" },
      null,
    ]) {
      const pool = makePool();
      setNode(pool, "Example Taiwan Node A", egress);
      const route = routeFor(egress?.identityKey || null, {
        scopeEligible: false,
        confidence: egress?.confidence || "unknown",
      });
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
      expect(getMihomoEgressBusinessState(pool, "4:192.0.2.20", "opencode").cooldownUntil).toBeNull();
      if (egress) expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.needsProbe).toBe(true);
    }
  });

  it("does not create egress cooldown for generic failures, and resets egress backoff on success", async () => {
    const pool = makePool();
    setNode(pool, "Example Taiwan Node A", stableEgress("4:198.51.100.20"));
    const route = routeFor();
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
    expect(success).toMatchObject({ updated: true, scope: "egress", identityKey: "4:198.51.100.20" });
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastSuccessAt: "1970-01-01T00:00:02.000Z" });
  });

  it("limits clean success writes to once per minute", async () => {
    const pool = makePool();
    setNode(pool, "Example Taiwan Node A", stableEgress("4:198.51.100.20"));
    const writes = { count: 0 };
    const mutatePool = mutatorFor(pool, writes);
    const getPool = async () => pool;
    const route = routeFor();

    await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool, getPool, nowMs: 1000 });
    await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool, getPool, nowMs: 2000 });
    await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool, getPool, nowMs: 62001 });
    expect(writes.count).toBe(2);
  });

  it("manually clears one identity/provider cooldown", async () => {
    const pool = makePool();
    pool.mihomoState.egressIdentities["4:198.51.100.20"] = {
      business: { opencode: { cooldownUntil: new Date(9999999999999).toISOString(), backoffLevel: 4, lastError: "429" } },
    };
    const result = await clearMihomoEgressCooldown({
      proxyPoolId: pool.id,
      identityKey: "4:198.51.100.20",
      businessProviderId: "opencode",
      mutatePool: mutatorFor(pool),
    });
    expect(result.updated).toBe(true);
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastError: null });
  });
});
