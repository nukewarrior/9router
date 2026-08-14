import { describe, expect, it } from "vitest";
import {
  getMihomoEgressBusinessState,
  recordMihomoRouteFailure,
  recordMihomoRouteSuccess,
} from "../../src/lib/network/mihomoState.js";

function makePool() {
  return {
    id: "race-pool",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      cooldown: { baseMs: 300000, multiplier: 3, maxMs: 1800000 },
    },
    mihomoState: {
      version: 2,
      proxyProviders: {},
      egressIdentities: {},
      maintenance: {},
    },
  };
}

function mutatorFor(pool) {
  return async (_id, mutator) => mutator(pool);
}

function setStableEgress(pool, identityKey = "4:198.51.100.20") {
  const [, ip] = identityKey.split(":");
  pool.mihomoState.proxyProviders.subscription = {
    nodes: {
      "Example Node": {
        egress: {
          ip,
          family: 4,
          identityKey,
          confidence: "stable",
          observedAt: 1,
          expiresAt: 9999999999999,
          lastProbeAt: 1,
          mappingVersion: 1,
        },
      },
    },
  };
}

function route(identityKey, attemptStartedAtMs) {
  return {
    proxyProvider: "subscription",
    nodeName: "Example Node",
    egressIdentityKey: identityKey,
    attemptStartedAtMs,
    egressSnapshot: {
      startedAtMs: attemptStartedAtMs,
      identityKey,
      confidence: "stable",
      observedAt: 1,
      expiresAt: 9999999999999,
      scopeEligible: true,
    },
  };
}

describe("Mihomo model-health evidence ordering", () => {
  it("keeps a newer model×identity cooldown when an older request succeeds", async () => {
    const pool = makePool();
    setStableEgress(pool);
    const oldRoute = route("4:198.51.100.20", 1000);

    await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: route("4:198.51.100.20", 2000),
      modelId: "opencode/model-a",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 3000,
    });
    await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route: oldRoute,
      modelId: "opencode/model-a",
      mutatePool: mutatorFor(pool),
      nowMs: 4000,
    });

    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode/model-a")).toMatchObject({
      status: "cooling",
      backoffLevel: 1,
      lastStatus: 429,
      cooldownUntil: "1970-01-01T00:05:03.000Z",
      lastErrorAt: "1970-01-01T00:00:03.000Z",
      lastSuccessAt: "1970-01-01T00:00:04.000Z",
    });
  });

  it("allows a newer success to clear an older cooldown", async () => {
    const pool = makePool();
    setStableEgress(pool);
    await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: route("4:198.51.100.20", 500),
      modelId: "opencode/model-a",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 1000,
    });
    await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route: route("4:198.51.100.20", 2000),
      modelId: "opencode/model-a",
      mutatePool: mutatorFor(pool),
      nowMs: 3000,
    });

    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode/model-a")).toMatchObject({
      status: "healthy",
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: 200,
    });
  });

  it("keeps evidence isolated by model and identity", async () => {
    const pool = makePool();
    setStableEgress(pool, "4:198.51.100.20");
    setStableEgress(pool, "4:203.0.113.31");

    await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: route("4:198.51.100.20", 1000),
      modelId: "opencode/model-a",
      status: 429,
      error: "rate limit",
      mutatePool: mutatorFor(pool),
      nowMs: 2000,
    });

    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode/model-a").cooldownUntil).not.toBeNull();
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode/model-b").cooldownUntil).toBeNull();
    expect(getMihomoEgressBusinessState(pool, "4:203.0.113.31", "opencode/model-a").cooldownUntil).toBeNull();
  });
});
