import { describe, expect, it } from "vitest";
import {
  clearMihomoRouteCooldown,
  getMihomoNodeBusinessState,
  recordMihomoRouteFailure,
  recordMihomoRouteSuccess,
} from "../../src/lib/network/mihomoState.js";

function makePool() {
  return {
    id: "pool-1",
    type: "mihomo",
    isActive: true,
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      cooldown: { baseMs: 300000, multiplier: 3, maxMs: 1800000 },
    },
    mihomoState: { proxyProviders: {} },
  };
}

function mutatorFor(pool) {
  return async (_id, mutator) => {
    const next = mutator(pool);
    return next;
  };
}

const route = { proxyProvider: "subscription", nodeName: "Example Taiwan Node A" };

describe("Mihomo node business cooldown", () => {
  it("writes provider-scoped node state and leaves pool status untouched", async () => {
    const pool = makePool();
    const first = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "rate limit exceeded",
      mutatePool: mutatorFor(pool),
      nowMs: 1700000000000,
    });

    expect(first).toMatchObject({ updated: true, cooldownMs: 300000, lastErrorType: "HTTP_429" });
    expect(pool.isActive).toBe(true);
    expect(pool).not.toHaveProperty("cooldownUntil");
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].business.opencode).toMatchObject({
      backoffLevel: 1,
      lastStatus: 429,
      lastErrorType: "HTTP_429",
    });
    expect(getMihomoNodeBusinessState(pool, route, "opencode").cooldownUntil).toBe("2023-11-14T22:18:20.000Z");
  });

  it("uses exponential local cooldown, provider reset, and success reset", async () => {
    const pool = makePool();
    await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 500, error: "FreeUsageLimitError", mutatePool: mutatorFor(pool), nowMs: 1000000 });
    const second = await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 500, error: "FreeUsageLimitError", mutatePool: mutatorFor(pool), nowMs: 1000000 });
    expect(second.cooldownMs).toBe(900000);

    const providerReset = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "rate limit",
      resetsAtMs: 1000000 + 120000,
      mutatePool: mutatorFor(pool),
      nowMs: 1000000,
    });
    expect(providerReset.cooldownMs).toBe(120000);

    const success = await recordMihomoRouteSuccess({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool: mutatorFor(pool), nowMs: 2000000 });
    expect(success.updated).toBe(true);
    expect(getMihomoNodeBusinessState(pool, route, "opencode")).toMatchObject({ cooldownUntil: null, backoffLevel: 0, lastSuccessAt: "1970-01-01T00:33:20.000Z" });
  });

  it("does not cooldown generic 5xx or provider-wide overload", async () => {
    const pool = makePool();
    const generic = await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 500, error: "upstream unavailable", mutatePool: mutatorFor(pool) });
    const overload = await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 503, error: "provider overloaded", mutatePool: mutatorFor(pool) });
    expect(generic.updated).toBe(false);
    expect(overload.updated).toBe(false);
    expect(pool.mihomoState).toEqual({ proxyProviders: {} });
  });

  it("clears one node/provider cooldown through the mutation boundary", async () => {
    const pool = makePool();
    await recordMihomoRouteFailure({ proxyPoolId: pool.id, route, businessProviderId: "opencode", status: 429, error: "429", mutatePool: mutatorFor(pool), nowMs: 1000 });
    const cleared = await clearMihomoRouteCooldown({ proxyPoolId: pool.id, route, businessProviderId: "opencode", mutatePool: mutatorFor(pool), nowMs: 2000 });
    expect(cleared.updated).toBe(true);
    expect(getMihomoNodeBusinessState(pool, route, "opencode")).toMatchObject({ cooldownUntil: null, backoffLevel: 0 });
  });
});
