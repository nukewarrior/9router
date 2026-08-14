import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyMihomoState } from "../../src/lib/network/mihomoConfig.js";
import { migrateMihomoState } from "../../src/lib/network/mihomoState.js";
import {
  getHealthyMihomoSnapshot,
  clearHealthyMihomoSnapshots,
} from "../../src/lib/network/mihomoHealthPool.js";
import {
  createMihomoMaintenanceService,
  selectMihomoMaintenanceModels,
} from "../../src/lib/network/mihomoMaintenanceService.js";
import { createMihomoMaintenanceScheduler } from "../../src/lib/network/mihomoMaintenanceScheduler.js";

const CONFIG = {
  controllerUrl: "http://127.0.0.1:9090",
  selectorName: "AUTO",
  providerNames: ["subscription"],
  egressProbeUrl: "https://api.ipify.org",
  inventoryRefreshMs: 300000,
  businessHealthRefreshMs: 60000,
  businessHealthTtlMs: 120000,
};

function makePool(id = "pool-1") {
  return {
    id,
    name: "Mihomo",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://127.0.0.1:7890",
    mihomo: { ...CONFIG },
    mihomoState: createEmptyMihomoState(),
  };
}

function clone(value) {
  return structuredClone(value);
}

function makeControllerClient() {
  return {
    async healthCheckProvider() {},
    async getProxy() {
      return { name: "AUTO", type: "Selector", now: "A", all: ["A", "B", "C"] };
    },
    async getProxies() {
      return {
        proxies: {
          A: { type: "Shadowsocks", alive: true, delay: 30 },
          B: { type: "Shadowsocks", alive: true, delay: 20 },
          C: { type: "Shadowsocks", alive: true, delay: 10 },
        },
      };
    },
    async getProxyProvider() {
      return { proxies: [{ name: "A" }, { name: "B" }, { name: "C" }] };
    },
  };
}

function makeHarness({ models = ["m1", "m2", "m3"], pool = makePool(), probeEgress, probeBusiness } = {}) {
  let currentPool = clone(pool);
  let currentModels = models.map((id) => ({ providerAlias: "oc", id, type: "llm" }));
  const client = makeControllerClient();
  const egressByNode = {
    A: "4:203.0.113.1",
    B: "4:203.0.113.2",
    C: "4:203.0.113.3",
  };
  const egressProbe = probeEgress || (async ({ mutatePool, poolId, proxyProvider, nodeName, expectedMappingVersion }) => {
    await mutatePool(poolId, (next) => {
      const state = migrateMihomoState(next.mihomoState);
      const provider = state.proxyProviders[proxyProvider] ||= { nodes: {} };
      const node = provider.nodes[nodeName] ||= { egress: null, transport: {} };
      const [family, ip] = egressByNode[nodeName].split(":");
      node.egress = {
        ip,
        family: Number(family),
        identityKey: egressByNode[nodeName],
        confidence: "stable",
        observedIps: [ip],
        sampleCount: 2,
        successfulSamples: 2,
        observedAt: 1000,
        expiresAt: 1000000,
        lastProbeAt: 1000,
        lastProbeError: null,
        needsProbe: false,
        mappingVersion: Number(expectedMappingVersion) + 1,
      };
      next.mihomoState = state;
      return next;
    });
    return { ok: true, stale: false, nodeName };
  });
  const businessProbe = probeBusiness || (async ({ mutatePool, poolId, modelId, entry, onHealthChanged }) => {
    await mutatePool(poolId, (next) => {
      const state = migrateMihomoState(next.mihomoState);
      const identity = state.egressIdentities[entry.identityKey] ||= { models: {} };
      identity.models[modelId] = {
        status: "healthy",
        refreshAt: "1970-01-01T00:20:00.000Z",
        expiresAt: "1970-01-01T00:30:00.000Z",
        cooldownUntil: null,
        backoffLevel: 0,
        lastStatus: 200,
        lastErrorType: null,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: "1970-01-01T00:00:01.000Z",
        evidenceVersion: 1,
        evidenceStartedAtMs: 1000,
        source: "probe",
      };
      next.mihomoState = state;
      return next;
    });
    await onHealthChanged?.({});
    return { ok: true, stale: false, modelId, identityKey: entry.identityKey };
  });

  const service = createMihomoMaintenanceService({
    getPools: async () => [currentPool],
    getPool: async () => currentPool,
    getModels: async () => currentModels,
    mutate: async (id, mutator) => {
      if (id !== currentPool.id || !currentPool) return currentPool;
      const next = mutator(clone(currentPool));
      currentPool = next;
      return currentPool;
    },
    makeClient: () => client,
    probeEgress: egressProbe,
    probeBusiness: businessProbe,
    scheduler: createMihomoMaintenanceScheduler(),
    now: () => 1000,
    tickMs: 3600000,
  });

  return {
    service,
    get pool() { return currentPool; },
    set models(value) {
      currentModels = value.map((id) => ({ providerAlias: "oc", id, type: "llm" }));
    },
    get models() { return currentModels; },
  };
}

describe("Mihomo maintenance service", () => {
  beforeEach(() => {
    clearHealthyMihomoSnapshots();
  });

  it("selects only sorted OpenCode LLM custom models", () => {
    expect(selectMihomoMaintenanceModels([
      { providerAlias: "other", id: "z", type: "llm" },
      { providerAlias: "oc", id: " m2 ", type: "llm" },
      { providerAlias: "oc", id: "m1", type: "image" },
      { providerAlias: "oc", id: "m2", type: "llm" },
      { providerAlias: "oc", id: "m1", type: "llm" },
    ])).toEqual(["m1", "m2"]);
  });

  it("publishes the first successful model/egress combination immediately and hydrates it on restart", async () => {
    const visibleCounts = [];
    const harness = makeHarness({
      models: ["m1"],
      probeBusiness: async ({ mutatePool, poolId, modelId, entry, onHealthChanged }) => {
        await mutatePool(poolId, (next) => {
          const state = migrateMihomoState(next.mihomoState);
          const identity = state.egressIdentities[entry.identityKey] ||= { models: {} };
          identity.models[modelId] = {
            status: "healthy",
            refreshAt: "1970-01-01T00:20:00.000Z",
            expiresAt: "1970-01-01T00:30:00.000Z",
            cooldownUntil: null,
            backoffLevel: 0,
            lastStatus: 200,
            lastErrorType: null,
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: "1970-01-01T00:00:01.000Z",
            evidenceVersion: 1,
            evidenceStartedAtMs: 1000,
            source: "probe",
          };
          next.mihomoState = state;
          return next;
        });
        await onHealthChanged?.({});
        visibleCounts.push(getHealthyMihomoSnapshot({ poolId: "pool-1", modelId: "m1" }).entries.length);
        return { ok: true };
      },
    });
    await harness.service.start();
    await harness.service.drain();

    expect(visibleCounts[0]).toBe(1);
    const snapshot = getHealthyMihomoSnapshot({ poolId: "pool-1", modelId: "m1" });
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries.every((entry) => entry.nodes.length === 1)).toBe(true);

    harness.service.stop();
    const restarted = makeHarness({ models: ["m1"], pool: harness.pool });
    const startPromise = restarted.service.start();
    await startPromise;
    const hydrated = getHealthyMihomoSnapshot({ poolId: "pool-1", modelId: "m1" });
    expect(hydrated.entries).toHaveLength(3);
    await restarted.service.drain();
    restarted.service.stop();
  });

  it("fairly expands three models across three egress groups", async () => {
    const calls = [];
    const harness = makeHarness({
      models: ["m1", "m2", "m3"],
      probeBusiness: async ({ mutatePool, poolId, modelId, entry, onHealthChanged }) => {
        calls.push(`${modelId}:${entry.identityKey}`);
        await mutatePool(poolId, (next) => {
          const state = migrateMihomoState(next.mihomoState);
          const identity = state.egressIdentities[entry.identityKey] ||= { models: {} };
          identity.models[modelId] = {
            status: "healthy",
            refreshAt: "1970-01-01T00:20:00.000Z",
            expiresAt: "1970-01-01T00:30:00.000Z",
            cooldownUntil: null,
            backoffLevel: 0,
            lastStatus: 200,
            lastErrorType: null,
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: "1970-01-01T00:00:01.000Z",
            evidenceVersion: 1,
            evidenceStartedAtMs: 1000,
            source: "probe",
          };
          next.mihomoState = state;
          return next;
        });
        await onHealthChanged?.({});
        return { ok: true };
      },
    });
    await harness.service.start();
    await harness.service.drain();

    expect(calls).toEqual([
      "m1:4:203.0.113.1",
      "m2:4:203.0.113.1",
      "m3:4:203.0.113.1",
      "m1:4:203.0.113.2",
      "m2:4:203.0.113.2",
      "m3:4:203.0.113.2",
      "m1:4:203.0.113.3",
      "m2:4:203.0.113.3",
      "m3:4:203.0.113.3",
    ]);
    harness.service.stop();
  });

  it("honors scoped manual refreshes without running unrelated maintenance work", async () => {
    const egressCalls = [];
    const businessCalls = [];
    const harness = makeHarness({
      models: ["m1", "m2"],
      probeEgress: async ({ mutatePool, poolId, proxyProvider, nodeName, expectedMappingVersion }) => {
        egressCalls.push(nodeName);
        await mutatePool(poolId, (next) => {
          const state = migrateMihomoState(next.mihomoState);
          const provider = state.proxyProviders[proxyProvider] ||= { nodes: {} };
          const node = provider.nodes[nodeName] ||= { egress: null, transport: {} };
          node.egress = {
            ip: nodeName === "A" ? "203.0.113.1" : nodeName === "B" ? "203.0.113.2" : "203.0.113.3",
            family: 4,
            identityKey: `4:${nodeName === "A" ? "203.0.113.1" : nodeName === "B" ? "203.0.113.2" : "203.0.113.3"}`,
            confidence: "stable",
            sampleCount: 2,
            successfulSamples: 2,
            observedAt: 1000,
            expiresAt: 1000000,
            lastProbeAt: 1000,
            needsProbe: false,
            mappingVersion: Number(expectedMappingVersion) + 1,
          };
          next.mihomoState = state;
          return next;
        });
        return { ok: true, stale: false };
      },
      probeBusiness: async (options) => {
        businessCalls.push(`${options.modelId}:${options.entry.identityKey}`);
        return { ok: true, stale: false };
      },
    });
    await harness.service.start();
    await harness.service.drain();
    egressCalls.length = 0;
    businessCalls.length = 0;

    const modelRefresh = await harness.service.refresh("pool-1", { scope: "model", modelId: "m1" });
    expect(modelRefresh).toMatchObject({ accepted: true, scope: "model", modelId: "m1" });
    await harness.service.drain();
    expect(egressCalls).toEqual([]);
    expect(businessCalls).toEqual([
      "m1:4:203.0.113.1",
      "m1:4:203.0.113.2",
      "m1:4:203.0.113.3",
    ]);

    egressCalls.length = 0;
    businessCalls.length = 0;
    await harness.service.refresh("pool-1", { scope: "egress", modelId: "m2", identityKey: "4:203.0.113.2" });
    await harness.service.drain();
    expect(egressCalls).toEqual([]);
    expect(businessCalls).toEqual(["m2:4:203.0.113.2"]);

    harness.service.stop();
  });

  it("coalesces duplicate wake calls and cleans up deleted models and inactive pools", async () => {
    let activeCycles = 0;
    let maxActiveCycles = 0;
    const cycleIds = new Set();
    const harness = makeHarness({
      models: ["m1"],
      probeEgress: async (options) => {
        cycleIds.add(options.cycleId);
        activeCycles += 1;
        maxActiveCycles = Math.max(maxActiveCycles, activeCycles);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeCycles -= 1;
        return { ok: true, stale: false };
      },
    });
    await harness.service.start();
    await Promise.all([
      harness.service.wake("pool-1", "config-changed"),
      harness.service.wake("pool-1", "config-changed"),
    ]);
    await harness.service.drain();
    expect(maxActiveCycles).toBe(1);
    expect(cycleIds.size).toBeGreaterThanOrEqual(1);

    harness.models = [];
    await harness.service.wake(null, "models-changed");
    await harness.service.drain();
    expect(getHealthyMihomoSnapshot({ poolId: "pool-1", modelId: "m1" })).toBeNull();

    harness.pool.isActive = false;
    await harness.service.wake("pool-1", "deactivated");
    expect(harness.service.snapshot().pools).toHaveLength(0);
    harness.service.stop();
  });
});
