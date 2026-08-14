import { describe, expect, it, vi } from "vitest";
import {
  evaluateEgressProbeSamples,
  normalizeEgressIdentity,
  probeMihomoNodeEgress,
} from "../../src/lib/network/mihomoEgressDiscovery.js";

function makePool(overrides = {}) {
  return {
    id: "egress-pool",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      samplesPerNode: 2,
      egressProbeTtlMs: 60000,
      egressProbeUrl: "https://probe.example.test/ip",
      ...overrides,
    },
    mihomoState: { proxyProviders: {}, egressIdentities: {} },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

describe("Mihomo egress identity normalization", () => {
  it("canonicalizes IPv4 and IPv6 into family-qualified keys", () => {
    expect(normalizeEgressIdentity(" 198.51.100.20\n")).toEqual({
      ip: "198.51.100.20",
      family: 4,
      identityKey: "4:198.51.100.20",
    });
    expect(normalizeEgressIdentity("2001:0db8:0:0:0:0:2:1")).toEqual({
      ip: "2001:db8::2:1",
      family: 6,
      identityKey: "6:2001:db8::2:1",
    });
    expect(normalizeEgressIdentity("::ffff:192.0.2.128")).toEqual({
      ip: "::ffff:c000:280",
      family: 6,
      identityKey: "6:::ffff:c000:280",
    });
  });

  it("rejects HTML, malformed and whitespace-containing probe bodies", () => {
    expect(normalizeEgressIdentity("<html>429 Too Many Requests</html>")).toBeNull();
    expect(normalizeEgressIdentity("not-an-ip")).toBeNull();
    expect(normalizeEgressIdentity("192.0.2.20 extra")).toBeNull();
  });
});

describe("Mihomo egress probe sample evaluation", () => {
  it("distinguishes stable, dynamic, tentative and unknown mappings", () => {
    expect(evaluateEgressProbeSamples(["192.0.2.20", "192.0.2.20"], { nowMs: 1000, ttlMs: 5000 })).toMatchObject({
      confidence: "stable",
      identityKey: "4:192.0.2.20",
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 1000,
      expiresAt: 6000,
    });
    expect(evaluateEgressProbeSamples(["192.0.2.20", "192.0.2.21"], { nowMs: 1000 })).toMatchObject({
      confidence: "dynamic",
      identityKey: null,
      observedIps: ["192.0.2.20", "192.0.2.21"],
    });
    expect(evaluateEgressProbeSamples(["192.0.2.20"], { nowMs: 1000 })).toMatchObject({ confidence: "tentative", successfulSamples: 1 });
    expect(evaluateEgressProbeSamples([null, null], { errors: [new Error("timeout"), "proxy failed"], nowMs: 1000 })).toMatchObject({
      confidence: "unknown",
      successfulSamples: 0,
      sampleCount: 2,
      lastProbeError: "proxy failed",
    });
  });
});

describe("Mihomo egress node discovery", () => {
  it("holds the Selector lease, verifies the node, and uses fresh strict connections", async () => {
    const pool = makePool();
    let selectedNode = null;
    const events = [];
    const client = {
      selectProxy: vi.fn(async (_selector, nodeName) => {
        selectedNode = nodeName;
        events.push(`PUT:${nodeName}`);
      }),
      getProxy: vi.fn(async () => {
        events.push("GET");
        return { type: "Selector", now: selectedNode };
      }),
    };
    const mutatePool = async (_id, mutator) => mutator(pool);
    const fetchProbe = vi.fn(async (_url, _options, proxyOptions) => {
      events.push(`PROBE:${selectedNode}`);
      expect(proxyOptions).toMatchObject({
        strictProxy: true,
        ephemeralProxyDispatcher: true,
        connectionProxyUrl: "http://router:18081",
      });
      return response("198.51.100.20\n");
    });

    const result = await probeMihomoNodeEgress({
      poolId: pool.id,
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      getPool: async () => pool,
      makeClient: () => client,
      fetchProbe,
      mutatePool,
      nowMs: 1000,
    });

    expect(result).toMatchObject({ ok: true, egress: { confidence: "stable", identityKey: "4:198.51.100.20" } });
    expect(fetchProbe).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["PUT:Example Taiwan Node A", "GET", "PROBE:Example Taiwan Node A", "PROBE:Example Taiwan Node A"]);
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress).toMatchObject({
      confidence: "stable",
      identityKey: "4:198.51.100.20",
      expiresAt: 61000,
    });
  });

  it("records an unknown mapping when a strict probe fails", async () => {
    const pool = makePool({ samplesPerNode: 1 });
    const client = {
      selectProxy: vi.fn(),
      getProxy: vi.fn().mockResolvedValue({ type: "Selector", now: "Example Taiwan Node A" }),
    };
    const result = await probeMihomoNodeEgress({
      poolId: pool.id,
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      getPool: async () => pool,
      makeClient: () => client,
      fetchProbe: vi.fn(async () => { throw new Error("connect refused"); }),
      mutatePool: async (_id, mutator) => mutator(pool),
      nowMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.egress).toMatchObject({ confidence: "unknown", lastProbeError: "connect refused" });
    expect(pool.mihomoState.proxyProviders.subscription.nodes["Example Taiwan Node A"].egress.confidence).toBe("unknown");
  });
});
