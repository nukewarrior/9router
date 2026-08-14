import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMihomoEgressScheduler,
  getMihomoEgressProbeReason,
} from "../../src/lib/network/mihomoEgressScheduler.js";
import { probeMihomoNodesEgress } from "../../src/lib/network/mihomoEgressDiscovery.js";
import { clearMihomoNodeDirectoryCache } from "../../src/lib/network/mihomoState.js";
import { prepareMihomoRouteAttempt } from "../../src/lib/network/mihomoRouteManager.js";
import { rebuildHealthyMihomoSnapshot } from "../../src/lib/network/mihomoHealthPool.js";

function makePool() {
  return {
    id: "scheduler-pool",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      providerNames: ["subscription"],
      egressProbeTtlMs: 60000,
    },
    mihomoState: {
      version: 2,
      proxyProviders: {
        subscription: {
          nodes: {
            "JP-STALE": { egress: { confidence: "stable", expiresAt: 1, needsProbe: false } },
            "JP-NEEDS": { egress: { confidence: "stable", expiresAt: 9999999999999, needsProbe: true } },
            "Example Japan Expiring Node": { egress: { confidence: "stable", expiresAt: 110000, needsProbe: false } },
          },
        },
      },
      egressIdentities: {},
    },
  };
}

function clientFor(nodes) {
  return {
    getProxy: async () => ({ type: "Selector", now: nodes[0], all: nodes }),
    getProxies: async () => ({ proxies: Object.fromEntries(nodes.map((name) => [name, { type: "VLESS", alive: true }])) }),
    getProxyProvider: async () => ({ proxies: nodes.map((name) => ({ name, type: "VLESS" })) }),
  };
}

beforeEach(() => clearMihomoNodeDirectoryCache());

describe("Mihomo egress scheduler", () => {
  it("deduplicates a node and processes jobs serially", async () => {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = createMihomoEgressScheduler({
      probeNode: async ({ nodeName }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(nodeName);
        await Promise.resolve();
        active -= 1;
        return { ok: true };
      },
    });

    expect(scheduler.enqueue({ poolId: "p", proxyProvider: "sub", nodeName: "A" })).toMatchObject({ queued: true });
    expect(scheduler.enqueue({ poolId: "p", proxyProvider: "sub", nodeName: "A" })).toMatchObject({ queued: false, reason: "duplicate" });
    expect(scheduler.enqueue({ poolId: "p", proxyProvider: "sub", nodeName: "B" })).toMatchObject({ queued: true });
    await scheduler.drain();

    expect(calls).toEqual(["A", "B"]);
    expect(maxActive).toBe(1);
    expect(scheduler.snapshot()).toMatchObject({ pending: 0, running: null });
  });

  it("backs off failed probes and resets backoff after a successful retry", async () => {
    let nowMs = 0;
    let attempts = 0;
    const scheduler = createMihomoEgressScheduler({
      now: () => nowMs,
      backoffMs: [60000, 180000],
      probeNode: async () => {
        attempts += 1;
        return { ok: attempts > 1 };
      },
    });

    expect(scheduler.enqueue({ poolId: "p", nodeName: "A" })).toMatchObject({ queued: true });
    await scheduler.drain();
    expect(scheduler.snapshot().entries[0]).toMatchObject({ backoffLevel: 1, nextAttemptAt: 60000 });
    expect(scheduler.enqueue({ poolId: "p", nodeName: "A" })).toMatchObject({ queued: false, reason: "backoff" });

    nowMs = 60000;
    expect(scheduler.enqueue({ poolId: "p", nodeName: "A" })).toMatchObject({ queued: true });
    await scheduler.drain();
    expect(attempts).toBe(2);
    expect(scheduler.snapshot().entries[0]).toMatchObject({ backoffLevel: 0, nextAttemptAt: 0, lastError: null });
  });

  it("recognizes unknown, needsProbe, stale and expiring mappings", () => {
    expect(getMihomoEgressProbeReason(null, { nowMs: 100000, ttlMs: 60000 })).toBe("unknown");
    expect(getMihomoEgressProbeReason({ needsProbe: true, expiresAt: 999999 }, { nowMs: 100000, ttlMs: 60000 })).toBe("needsProbe");
    expect(getMihomoEgressProbeReason({ confidence: "stable", expiresAt: 999 }, { nowMs: 100000, ttlMs: 60000 })).toBe("stale");
    expect(getMihomoEgressProbeReason({ confidence: "stable", expiresAt: 110000 }, { nowMs: 100000, ttlMs: 60000 })).toBe("expiring");
    expect(getMihomoEgressProbeReason({ confidence: "stable", expiresAt: 999999 }, { nowMs: 100000, ttlMs: 60000 })).toBeNull();
  });

  it("selects a prepublished healthy route without enqueuing maintenance", async () => {
    const pool = makePool();
    pool.mihomoState.maintenance = { selectedModels: ["model-a"], nodeCount: 1, nextRunAt: 200000 };
    pool.mihomoState.proxyProviders.subscription.nodes["Example Japan Expiring Node"].egress = {
      ip: "198.51.100.31",
      family: 4,
      identityKey: "4:198.51.100.31",
      confidence: "stable",
      observedAt: 1,
      expiresAt: 9999999999999,
      mappingVersion: 1,
    };
    pool.mihomoState.egressIdentities["4:198.51.100.31"] = {
      models: {
        "model-a": {
          status: "healthy",
          refreshAt: new Date(200000).toISOString(),
          expiresAt: new Date(300000).toISOString(),
          evidenceVersion: 1,
        },
      },
    };
    rebuildHealthyMihomoSnapshot({
      pool,
      modelId: "model-a",
      directory: { nodes: [{
        key: "subscription\0Example Japan Expiring Node",
        proxyProvider: "subscription",
        nodeName: "Example Japan Expiring Node",
        region: "JP",
        alive: true,
      }] },
      nowMs: 100000,
    });
    const queued = vi.fn(() => ({ queued: true }));
    const context = { attemptedEgressKeys: new Set(), attemptedNodeKeysByEgress: new Map(), attempts: 0 };
    const startedAt = Date.now();
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      modelId: "model-a",
      routeContext: context,
      getPool: async () => pool,
      enqueueProbe: queued,
      nowMs: 100000,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.route).toMatchObject({ nodeName: "Example Japan Expiring Node", attemptStartedAtMs: 100000 });
    expect(queued).not.toHaveBeenCalled();
    result.reservation.release();
  });

  it("queues a bounded batch without waiting for probe samples", async () => {
    const pool = makePool();
    const queueProbe = vi.fn(() => ({ queued: 2, skipped: 0 }));
    const nodes = ["JP-STALE", "JP-NEEDS", "Example Japan Expiring Node", "JP-UNKNOWN"];
    const result = await probeMihomoNodesEgress({
      poolId: pool.id,
      getPool: async () => pool,
      makeClient: () => clientFor(nodes),
      queueOnly: true,
      limit: 2,
      queueProbe,
      nowMs: 100000,
    });

    expect(result).toMatchObject({ ok: true, requested: 2, queued: 2, skipped: 0, results: [] });
    expect(queueProbe).toHaveBeenCalledTimes(1);
    expect(queueProbe.mock.calls[0][0].nodes).toHaveLength(2);
  });
});
