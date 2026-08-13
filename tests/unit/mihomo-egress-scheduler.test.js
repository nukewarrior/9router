import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMihomoEgressScheduler,
  getMihomoEgressProbeReason,
} from "../../src/lib/network/mihomoEgressScheduler.js";
import { clearMihomoNodeDirectoryCache } from "../../src/lib/network/mihomoState.js";
import { prepareMihomoRouteAttempt } from "../../src/lib/network/mihomoRouteManager.js";

function makePool() {
  return {
    id: "scheduler-pool",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:17892",
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
      selectorName: "selector",
      providerNames: ["subscription"],
      egressProbeTtlMs: 60000,
    },
    mihomoState: {
      proxyProviders: {
        subscription: {
          nodes: {
            "JP-STALE": { egress: { confidence: "stable", expiresAt: 1, needsProbe: false } },
            "JP-NEEDS": { egress: { confidence: "stable", expiresAt: 9999999999999, needsProbe: true } },
            "JP-EXPIRING": { egress: { confidence: "stable", expiresAt: 110000, needsProbe: false } },
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

  it("enqueues maintenance without delaying route selection", async () => {
    const pool = makePool();
    const queued = vi.fn(() => ({ queued: true }));
    const nodes = ["JP-STALE", "JP-NEEDS", "JP-EXPIRING", "JP-UNKNOWN"];
    const context = { attemptedNodeKeys: new Set(), attemptedEgressKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const startedAt = Date.now();
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: context,
      getPool: async () => pool,
      makeClient: () => clientFor(nodes),
      enqueueProbe: queued,
      nowMs: 100000,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.route).toMatchObject({ nodeName: "JP-EXPIRING", attemptStartedAtMs: 100000 });
    expect(queued).toHaveBeenCalledTimes(4);
    expect(queued.mock.calls.map(([options]) => options.reason)).toEqual([
      "stale",
      "needsProbe",
      "expiring",
      "unknown",
    ]);
  });
});
