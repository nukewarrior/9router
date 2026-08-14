import { describe, expect, it } from "vitest";
import {
  getMihomoEgressBusinessState,
  recordMihomoRouteFailure,
} from "../../src/lib/network/mihomoState.js";

function makePool() {
  return {
    id: "refresh-on-rate-limit",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      egressScopedCooldown: true,
      cooldown: { baseMs: 300000, multiplier: 3, maxMs: 1800000 },
    },
    mihomoState: {
      proxyProviders: {
        subscription: {
          nodes: {
            "Example Taiwan Node A": {
              egress: {
                ip: "198.51.100.20",
                family: 4,
                identityKey: "4:198.51.100.20",
                confidence: "stable",
                observedAt: 1,
                expiresAt: 9999999999999,
                needsProbe: false,
              },
            },
          },
        },
      },
      egressIdentities: {},
    },
  };
}

function mutatorFor(pool) {
  return async (_id, mutator) => mutator(pool);
}

function routeFor(identityKey = "4:198.51.100.20", scopeEligible = true) {
  return {
    proxyProvider: "subscription",
    nodeName: "Example Taiwan Node A",
    attemptStartedAtMs: 1000,
    egressSnapshot: {
      startedAtMs: 1000,
      identityKey,
      confidence: "stable",
      observedAt: 1,
      expiresAt: 9999999999999,
      scopeEligible,
    },
  };
}

describe("Mihomo egress cooldown after rate limit", () => {
  it("writes model×egress cooldown without remapping the node", async () => {
    const pool = makePool();
    const route = routeFor();

    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 429,
      error: "TooManyRequests",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });

    expect(result).toMatchObject({ updated: true, scope: "egress", identityKey: "4:198.51.100.20" });
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.needsProbe).toBe(false);
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toMatchObject({
      backoffLevel: 1,
      lastStatus: 429,
    });
  });

  it("keeps FreeUsageLimitError model×egress-scoped without remapping", async () => {
    const pool = makePool();
    const route = routeFor();

    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route,
      businessProviderId: "opencode",
      status: 500,
      error: "FreeUsageLimitError: quota exceeded",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });

    expect(result.scope).toBe("egress");
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.needsProbe).toBe(false);
  });

  it("does not mark mappings for a generic upstream failure", async () => {
    const pool = makePool();
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: routeFor(),
      businessProviderId: "opencode",
      status: 500,
      error: "upstream unavailable",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });

    expect(result.updated).toBe(false);
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.needsProbe).toBe(false);
  });
});
