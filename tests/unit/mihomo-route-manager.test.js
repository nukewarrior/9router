import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMihomoRotationState,
  prepareMihomoRouteAttempt,
} from "../../src/lib/network/mihomoRouteManager.js";
import {
  clearHealthyMihomoSnapshots,
  getHealthyMihomoSnapshot,
  rebuildHealthyMihomoSnapshot,
} from "../../src/lib/network/mihomoHealthPool.js";
import { createEmptyMihomoState } from "../../src/lib/network/mihomoConfig.js";

const NOW = 1000;

function makePool(id = "pool-route", models = ["model-a"]) {
  return {
    id,
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18080",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      maxAttemptsPerRequest: 6,
      admissionWaitMs: 0,
      maxInFlightStartsPerEgress: 1,
    },
    mihomoState: {
      ...createEmptyMihomoState(),
      maintenance: {
        ...createEmptyMihomoState().maintenance,
        selectedModels: models,
        nodeCount: 3,
        nextRunAt: new Date(NOW + 300000).toISOString(),
      },
    },
  };
}

function setNode(pool, nodeName, identityKey, { provider = "subscription", region = "OTHER" } = {}) {
  const [, ip] = identityKey.split(":");
  pool.mihomoState.proxyProviders[provider] ||= { nodes: {} };
  pool.mihomoState.proxyProviders[provider].nodes[nodeName] = {
    egress: {
      ip,
      family: 4,
      identityKey,
      confidence: "stable",
      observedIps: [ip, ip],
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 100,
      expiresAt: 9999999999999,
      lastProbeAt: 100,
      lastProbeError: null,
      needsProbe: false,
      mappingVersion: 1,
    },
    transport: {
      status: "healthy",
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSuccessAt: "1970-01-01T00:00:00.100Z",
    },
  };
  pool.mihomoState.egressIdentities[identityKey] ||= { models: {} };
  pool.mihomoState.egressIdentities[identityKey].models["model-a"] = {
    status: "healthy",
    refreshAt: new Date(NOW + 60000).toISOString(),
    expiresAt: new Date(NOW + 300000).toISOString(),
    cooldownUntil: null,
    evidenceVersion: 3,
    evidenceStartedAtMs: 100,
    lastSuccessAt: new Date(100).toISOString(),
    source: "probe",
  };
  return {
    key: `${provider}\0${nodeName}`,
    proxyProvider: provider,
    nodeName,
    region,
    alive: true,
    delayMs: 10,
  };
}

function publish(pool, nodes, modelId = "model-a") {
  rebuildHealthyMihomoSnapshot({
    pool,
    modelId,
    directory: { selectorName: "selector", nodes },
    nowMs: NOW,
  });
}

function context() {
  return {
    attemptedEgressKeys: new Set(),
    attemptedNodeKeysByEgress: new Map(),
    attempts: 0,
  };
}

beforeEach(() => {
  clearMihomoRotationState();
  clearHealthyMihomoSnapshots();
});

describe("Mihomo snapshot-only request routing", () => {
  it("does not discover nodes and returns an immutable model/egress route snapshot", async () => {
    const pool = makePool();
    const nodes = [setNode(pool, "Node A", "4:192.0.2.20", { region: "TW" })];
    publish(pool, nodes);
    const makeClient = () => {
      throw new Error("request route must not create a Mihomo client");
    };
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      modelId: "model-a",
      routeContext: context(),
      getPool: async () => pool,
      makeClient,
      nowMs: NOW,
    });

    expect(result.route).toMatchObject({
      modelId: "model-a",
      nodeName: "Node A",
      egressIdentityKey: "4:192.0.2.20",
      mappingVersion: 1,
      egressSnapshot: {
        identityKey: "4:192.0.2.20",
        evidenceVersion: 3,
        scopeEligible: true,
      },
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.entry)).toBe(true);
    expect(getHealthyMihomoSnapshot({ poolId: pool.id, modelId: "model-a" }).entries).toHaveLength(1);
    expect(result.reservation.release()).toBe(true);
    expect(result.reservation.release()).toBe(false);
  });

  it("uses distinct egress identities and bounds max attempts to the first snapshot", async () => {
    const pool = makePool();
    const nodes = [
      setNode(pool, "Node A", "4:192.0.2.20"),
      setNode(pool, "Node B", "4:192.0.2.20"),
      setNode(pool, "Node C", "4:192.0.2.21"),
    ];
    publish(pool, nodes);
    const routeContext = context();
    const first = await prepareMihomoRouteAttempt({ poolId: pool.id, modelId: "model-a", routeContext, getPool: async () => pool, nowMs: NOW });
    first.reservation.release();
    const second = await prepareMihomoRouteAttempt({ poolId: pool.id, modelId: "model-a", routeContext, getPool: async () => pool, nowMs: NOW });
    second.reservation.release();
    const third = await prepareMihomoRouteAttempt({ poolId: pool.id, modelId: "model-a", routeContext, getPool: async () => pool, nowMs: NOW });

    expect(first.route.egressIdentityKey).not.toBe(second.route.egressIdentityKey);
    expect(routeContext.maxAttempts).toBe(2);
    expect(third.route).toBeNull();
  });

  it("fails closed for unmanaged, warming, empty-node, and all-cooling states", async () => {
    const unmanaged = makePool("unmanaged", ["other-model"]);
    await expect(prepareMihomoRouteAttempt({
      poolId: unmanaged.id,
      modelId: "model-a",
      routeContext: context(),
      getPool: async () => unmanaged,
      nowMs: NOW,
    })).rejects.toMatchObject({ code: "MIHOMO_MODEL_NOT_MANAGED", status: 503 });

    const warming = makePool("warming");
    await expect(prepareMihomoRouteAttempt({
      poolId: warming.id,
      modelId: "model-a",
      routeContext: context(),
      getPool: async () => warming,
      nowMs: NOW,
    })).rejects.toMatchObject({ code: "MIHOMO_POOL_WARMING", status: 503 });

    const empty = makePool("empty");
    empty.mihomoState.maintenance.nodeCount = 0;
    await expect(prepareMihomoRouteAttempt({
      poolId: empty.id,
      modelId: "model-a",
      routeContext: context(),
      getPool: async () => empty,
      nowMs: NOW,
    })).rejects.toMatchObject({ code: "MIHOMO_NO_ELIGIBLE_NODES", status: 503 });

    const cooling = makePool("cooling");
    const node = setNode(cooling, "Node A", "4:192.0.2.20");
    cooling.mihomoState.egressIdentities["4:192.0.2.20"].models["model-a"].status = "cooling";
    cooling.mihomoState.egressIdentities["4:192.0.2.20"].models["model-a"].cooldownUntil = new Date(NOW + 30000).toISOString();
    publish(cooling, [node]);
    await expect(prepareMihomoRouteAttempt({
      poolId: cooling.id,
      modelId: "model-a",
      routeContext: context(),
      getPool: async () => cooling,
      nowMs: NOW,
    })).rejects.toMatchObject({ code: "MIHOMO_POOL_RATE_LIMITED", status: 429 });
  });
});
