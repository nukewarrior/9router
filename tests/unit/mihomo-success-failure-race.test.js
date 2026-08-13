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
    proxyUrl: "http://router:17892",
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
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

function setStableEgress(pool) {
  pool.mihomoState.proxyProviders.subscription = {
    nodes: {
      "TW-A10": {
        egress: {
          ip: "61.219.114.43",
          family: 4,
          identityKey: "4:61.219.114.43",
          confidence: "stable",
          observedAt: 1,
          expiresAt: 9999999999999,
        },
      },
    },
  };
}

async function recordFailure(pool, route, nowMs) {
  await recordMihomoRouteFailure({
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
      nodeName: "TW-A10",
      attemptStartedAtMs: 1000,
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
      ? getMihomoEgressBusinessState(pool, "4:61.219.114.43", "opencode")
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
      nodeName: "TW-A10",
      attemptStartedAtMs: 500,
    };
    await recordFailure(pool, failureRoute, 1000);

    await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route: { ...failureRoute, attemptStartedAtMs: 2000 },
      businessProviderId: "opencode",
      mutatePool: mutatorFor(pool),
      nowMs: 3000,
    });

    const state = egressScopedCooldown
      ? getMihomoEgressBusinessState(pool, "4:61.219.114.43", "opencode")
      : getMihomoNodeBusinessState(pool, failureRoute, "opencode");
    expect(state).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastStatus: 200 });
    expect(state.lastErrorAt).toBeNull();
  });
});
