import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMihomoEgressCooldown,
  getMihomoModelHealthState,
  getMihomoNodeTransportState,
  markMihomoNodeEgressNeedsProbe,
  recordMihomoNodeTransportFailure,
  recordMihomoNodeTransportSuccess,
  recordMihomoRouteFailure,
  recordMihomoRouteSuccess,
} from "../../src/lib/network/mihomoState.js";
import { createEmptyMihomoState } from "../../src/lib/network/mihomoConfig.js";

function makePool() {
  const state = createEmptyMihomoState();
  state.maintenance.selectedModels = ["model-a", "model-b"];
  return {
    id: "egress-cooldown",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
    },
    mihomoState: state,
  };
}

function setNode(pool, nodeName, identityKey = "4:198.51.100.20", mappingVersion = 1) {
  pool.mihomoState.proxyProviders.subscription ||= { nodes: {} };
  pool.mihomoState.proxyProviders.subscription.nodes[nodeName] = {
    egress: {
      ip: identityKey.slice(2),
      family: 4,
      identityKey,
      confidence: "stable",
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 100,
      expiresAt: 9999999999999,
      mappingVersion,
    },
  };
}

function route(identityKey = "4:198.51.100.20", modelId = "model-a", nodeName = "Node A", attemptStartedAtMs = 1000) {
  return {
    modelId,
    proxyProvider: "subscription",
    nodeName,
    egressIdentityKey: identityKey,
    mappingVersion: 1,
    attemptStartedAtMs,
    egressSnapshot: {
      identityKey,
      confidence: "stable",
      observedAt: 100,
      expiresAt: 9999999999999,
      scopeEligible: true,
    },
  };
}

function mutatePool(pool) {
  return async (_id, mutator) => mutator(pool);
}

beforeEach(() => {});

describe("Mihomo model×egress cooldown and node transport state", () => {
  it("writes a 429 cooldown only to the current model and egress identity", async () => {
    const pool = makePool();
    setNode(pool, "Node A");
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: route(),
      modelId: "model-a",
      status: 429,
      error: "rate limit",
      mutatePool: mutatePool(pool),
      nowMs: 1000,
    });

    expect(result).toMatchObject({ updated: true, scope: "egress", identityKey: "4:198.51.100.20", modelId: "model-a" });
    expect(getMihomoModelHealthState(pool, "4:198.51.100.20", "model-a")).toMatchObject({
      status: "cooling",
      backoffLevel: 1,
      lastStatus: 429,
    });
    expect(getMihomoModelHealthState(pool, "4:198.51.100.20", "model-b").status).toBe("unknown");
  });

  it("does not write model×egress state for ordinary upstream failures", async () => {
    const pool = makePool();
    setNode(pool, "Node A");
    const result = await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: route(),
      modelId: "model-a",
      status: 500,
      error: "provider overloaded",
      mutatePool: mutatePool(pool),
    });

    expect(result.updated).toBe(false);
    expect(pool.mihomoState.egressIdentities).toEqual({});
  });

  it("records transport cooling per node and ignores stale mapping results", async () => {
    const pool = makePool();
    setNode(pool, "Node A");
    const currentRoute = route();
    const failure = await recordMihomoNodeTransportFailure({
      proxyPoolId: pool.id,
      route: currentRoute,
      expectedMappingVersion: 1,
      errorType: "transport",
      error: "fetch failed",
      mutatePool: mutatePool(pool),
      nowMs: 1000,
    });
    expect(failure).toMatchObject({ updated: true, stale: false });
    expect(getMihomoNodeTransportState(pool, currentRoute)).toMatchObject({
      status: "cooling",
      consecutiveFailures: 1,
      lastError: "fetch failed",
    });

    pool.mihomoState.proxyProviders.subscription.nodes["Node A"].egress.mappingVersion = 2;
    const stale = await recordMihomoNodeTransportFailure({
      proxyPoolId: pool.id,
      route: currentRoute,
      expectedMappingVersion: 1,
      error: "old mapping failed",
      mutatePool: mutatePool(pool),
      nowMs: 2000,
    });
    expect(stale).toMatchObject({ updated: false, stale: true });
    expect(getMihomoNodeTransportState(pool, currentRoute).lastError).toBe("fetch failed");
  });

  it("marks a transport-exhausted mapping for background probing with a version guard", async () => {
    const pool = makePool();
    setNode(pool, "Node A");
    const currentRoute = route();
    const marked = await markMihomoNodeEgressNeedsProbe({
      proxyPoolId: pool.id,
      route: currentRoute,
      expectedMappingVersion: 1,
      mutatePool: mutatePool(pool),
    });
    expect(marked).toMatchObject({ updated: true, stale: false });
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Node A"].egress.needsProbe).toBe(true);

    pool.mihomoState.proxyProviders.subscription.nodes["Node A"].egress.mappingVersion = 2;
    pool.mihomoState.proxyProviders.subscription.nodes["Node A"].egress.needsProbe = false;
    const stale = await markMihomoNodeEgressNeedsProbe({
      proxyPoolId: pool.id,
      route: currentRoute,
      expectedMappingVersion: 1,
      mutatePool: mutatePool(pool),
    });
    expect(stale).toMatchObject({ updated: false, stale: true });
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Node A"].egress.needsProbe).toBe(false);
  });

  it("records successful model route evidence and clears only that model cooldown", async () => {
    const pool = makePool();
    setNode(pool, "Node A");
    const currentRoute = route();
    await recordMihomoRouteFailure({
      proxyPoolId: pool.id,
      route: currentRoute,
      modelId: "model-a",
      status: 429,
      error: "rate limit",
      mutatePool: mutatePool(pool),
      nowMs: 1000,
    });
    const success = await recordMihomoRouteSuccess({
      proxyPoolId: pool.id,
      route: currentRoute,
      modelId: "model-a",
      mutatePool: mutatePool(pool),
      nowMs: 2000,
    });
    expect(success).toMatchObject({ updated: true, scope: "egress", modelId: "model-a" });
    expect(getMihomoModelHealthState(pool, "4:198.51.100.20", "model-a")).toMatchObject({
      status: "healthy",
      cooldownUntil: null,
      backoffLevel: 0,
      lastSuccessAt: "1970-01-01T00:00:02.000Z",
    });

    const cleared = await clearMihomoEgressCooldown({
      proxyPoolId: pool.id,
      identityKey: "4:198.51.100.20",
      modelId: "model-a",
      mutatePool: mutatePool(pool),
    });
    expect(cleared).toMatchObject({ updated: true, modelId: "model-a" });
  });
});
