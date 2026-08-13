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
    proxyUrl: "http://router:17892",
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
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
    expect(normalizeEgressIdentity(" 61.219.114.43\n")).toEqual({
      ip: "61.219.114.43",
      family: 4,
      identityKey: "4:61.219.114.43",
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
    expect(normalizeEgressIdentity("1.2.3.4 extra")).toBeNull();
  });
});

describe("Mihomo egress probe sample evaluation", () => {
  it("distinguishes stable, dynamic, tentative and unknown mappings", () => {
    expect(evaluateEgressProbeSamples(["1.2.3.4", "1.2.3.4"], { nowMs: 1000, ttlMs: 5000 })).toMatchObject({
      confidence: "stable",
      identityKey: "4:1.2.3.4",
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 1000,
      expiresAt: 6000,
    });
    expect(evaluateEgressProbeSamples(["1.2.3.4", "1.2.3.5"], { nowMs: 1000 })).toMatchObject({
      confidence: "dynamic",
      identityKey: null,
      observedIps: ["1.2.3.4", "1.2.3.5"],
    });
    expect(evaluateEgressProbeSamples(["1.2.3.4"], { nowMs: 1000 })).toMatchObject({ confidence: "tentative", successfulSamples: 1 });
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
        connectionProxyUrl: "http://router:17892",
      });
      return response("61.219.114.43\n");
    });

    const result = await probeMihomoNodeEgress({
      poolId: pool.id,
      proxyProvider: "subscription",
      nodeName: "TW-A10",
      getPool: async () => pool,
      makeClient: () => client,
      fetchProbe,
      mutatePool,
      nowMs: 1000,
    });

    expect(result).toMatchObject({ ok: true, egress: { confidence: "stable", identityKey: "4:61.219.114.43" } });
    expect(fetchProbe).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["PUT:TW-A10", "GET", "PROBE:TW-A10", "PROBE:TW-A10"]);
    expect(pool.mihomoState.proxyProviders.subscription.nodes["TW-A10"].egress).toMatchObject({
      confidence: "stable",
      identityKey: "4:61.219.114.43",
      expiresAt: 61000,
    });
  });

  it("records an unknown mapping when a strict probe fails", async () => {
    const pool = makePool({ samplesPerNode: 1 });
    const client = {
      selectProxy: vi.fn(),
      getProxy: vi.fn().mockResolvedValue({ type: "Selector", now: "TW-A10" }),
    };
    const result = await probeMihomoNodeEgress({
      poolId: pool.id,
      proxyProvider: "subscription",
      nodeName: "TW-A10",
      getPool: async () => pool,
      makeClient: () => client,
      fetchProbe: vi.fn(async () => { throw new Error("connect refused"); }),
      mutatePool: async (_id, mutator) => mutator(pool),
      nowMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.egress).toMatchObject({ confidence: "unknown", lastProbeError: "connect refused" });
    expect(pool.mihomoState.proxyProviders.subscription.nodes["TW-A10"].egress.confidence).toBe("unknown");
  });
});
