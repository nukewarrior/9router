import { describe, expect, it } from "vitest";
import {
  getMihomoEgressBusinessState,
  getMihomoNodeBusinessState,
  recordMihomoRouteFailure,
  recordMihomoRouteSuccess,
} from "../../src/lib/network/mihomoState.js";

function makePool(egressScopedCooldown = false) {
  return {
    id: egressScopedCooldown ? "race-egress" : "race-node",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      egressScopedCooldown,
      cooldown: { baseMs: 300000, multiplier: 3, maxMs: 1800000 },
    },
    mihomoState: {
      proxyProviders: {},
      egressIdentities: {},
    },
  };
}

function mutatorFor(pool) {
  return async (_id, mutator) => mutator(pool);
}

function setStableEgress(pool, identityKey = "4:198.51.100.20", confidence = "stable") {
  const [, ip] = identityKey.split(":");
  pool.mihomoState.proxyProviders.subscription = {
    nodes: {
      "Example Taiwan Node A": {
        egress: {
          ip,
          family: 4,
          identityKey,
          confidence,
          observedAt: 1,
          expiresAt: 9999999999999,
          needsProbe: false,
        },
      },
    },
  };
}

function attemptSnapshot(identityKey, startedAtMs, scopeEligible = true) {
  return {
    startedAtMs,
    identityKey,
    confidence: "stable",
    observedAt: 1,
    expiresAt: 9999999999999,
    scopeEligible,
  };
}

async function recordFailure(pool, route, nowMs) {
  return recordMihomoRouteFailure({
    proxyPoolId: pool.id,
    route,
    businessProviderId: "opencode",
    status: 429,
    error: "rate limit",
    mutatePool: mutatorFor(pool),
    nowMs,
  });
}

describe("Mihomo success/failure temporal ordering", () => {
  it.each([
    ["node", false],
    ["egress", true],
  ])("keeps a newer %s cooldown when an older attempt succeeds", async (_scope, egressScopedCooldown) => {
    const pool = makePool(egressScopedCooldown);
    if (egressScopedCooldown) setStableEgress(pool);
    const route = {
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      attemptStartedAtMs: 1000,
      egressSnapshot: attemptSnapshot("4:198.51.100.20", 1000),
    };

    await recordFailure(pool, route, 3000);
    await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      mutatePool: mutatorFor(pool),
      nowMs: 4000,
    });

    const state = egressScopedCooldown
      ? getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")
      : getMihomoNodeBusinessState(pool, route, "opencode");
    expect(state).toMatchObject({ backoffLevel: 1, lastStatus: 429 });
    expect(state.cooldownUntil).toBe("1970-01-01T00:05:03.000Z");
    expect(state.lastErrorAt).toBe("1970-01-01T00:00:03.000Z");
    expect(state.lastSuccessAt).toBe("1970-01-01T00:00:04.000Z");
  });

  it.each([
    ["node", false],
    ["egress", true],
  ])("allows a new %s attempt to clear an older cooldown", async (_scope, egressScopedCooldown) => {
    const pool = makePool(egressScopedCooldown);
    if (egressScopedCooldown) setStableEgress(pool);
    const failureRoute = {
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      attemptStartedAtMs: 500,
      egressSnapshot: attemptSnapshot("4:198.51.100.20", 500),
    };
    await recordFailure(pool, failureRoute, 1000);

    await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route: {
        ...failureRoute,
        attemptStartedAtMs: 2000,
        egressSnapshot: { ...failureRoute.egressSnapshot, startedAtMs: 2000 },
      },
      businessProviderId: "opencode",
      mutatePool: mutatorFor(pool),
      nowMs: 3000,
    });

    const state = egressScopedCooldown
      ? getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")
      : getMihomoNodeBusinessState(pool, failureRoute, "opencode");
    expect(state).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastStatus: 200 });
    expect(state.lastErrorAt).toBeNull();
  });

  it("attributes an old E1 failure to E1 after the node remaps to E2", async () => {
    const pool = makePool(true);
    setStableEgress(pool);
    const route = {
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      attemptStartedAtMs: 1000,
      egressSnapshot: attemptSnapshot("4:198.51.100.20", 1000),
    };

    setStableEgress(pool, "4:203.0.113.31");
    const result = await recordFailure(pool, route, 2000);

    expect(result).toMatchObject({ scope: "egress", identityKey: "4:198.51.100.20" });
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toMatchObject({
      backoffLevel: 1,
      lastStatus: 429,
    });
    expect(getMihomoEgressBusinessState(pool, "4:203.0.113.31", "opencode").cooldownUntil).toBeNull();
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.needsProbe).toBe(false);
    expect(getMihomoNodeBusinessState(pool, route, "opencode").cooldownUntil).toBeNull();
  });

  it("does not let an old E1 success clear a newer E2 cooldown", async () => {
    const pool = makePool(true);
    setStableEgress(pool);
    const oldRoute = {
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      attemptStartedAtMs: 1000,
      egressSnapshot: attemptSnapshot("4:198.51.100.20", 1000),
    };

    setStableEgress(pool, "4:203.0.113.31");
    const newRoute = {
      ...oldRoute,
      attemptStartedAtMs: 2000,
      egressSnapshot: attemptSnapshot("4:203.0.113.31", 2000),
    };
    await recordFailure(pool, newRoute, 3000);

    await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route: oldRoute,
      businessProviderId: "opencode",
      mutatePool: mutatorFor(pool),
      nowMs: 4000,
    });

    expect(getMihomoEgressBusinessState(pool, "4:203.0.113.31", "opencode")).toMatchObject({
      backoffLevel: 1,
      lastStatus: 429,
    });
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toMatchObject({
      cooldownUntil: null,
      lastStatus: 200,
    });
  });

  it("keeps a tentative attempt node-scoped after its mapping becomes stable", async () => {
    const pool = makePool(true);
    setStableEgress(pool, "4:198.51.100.20", "tentative");
    const route = {
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      attemptStartedAtMs: 1000,
      egressSnapshot: attemptSnapshot("4:198.51.100.20", 1000, false),
    };

    setStableEgress(pool);
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 2000,
    });

    expect(result).toMatchObject({ scope: "node", identityKey: null });
    expect(getMihomoNodeBusinessState(pool, route, "opencode")).toMatchObject({ backoffLevel: 1, lastStatus: 429 });
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode").cooldownUntil).toBeNull();
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.needsProbe).toBe(true);
  });
});
