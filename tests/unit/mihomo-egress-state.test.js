import { describe, expect, it } from "vitest";
import {
  getMihomoEgressBusinessState,
  getMihomoNodeEgress,
  isMihomoEgressFresh,
  recordMihomoNodeEgress,
} from "../../src/lib/network/mihomoState.js";

function makePool() {
  return {
    id: "state-pool",
    type: "mihomo",
    mihomo: { controllerUrl: "http://192.0.2.10:9090", selectorName: "selector" },
    mihomoState: { proxyProviders: {}, egressIdentities: {} },
  };
}

const mapping = {
  ip: "198.51.100.20",
  family: 4,
  identityKey: "4:198.51.100.20",
  confidence: "stable",
  observedIps: ["198.51.100.20"],
  sampleCount: 2,
  successfulSamples: 2,
  observedAt: 1000,
  expiresAt: 6000,
  lastProbeAt: 1000,
  lastProbeError: null,
};

describe("Mihomo egress state", () => {
  it("stores node mappings atomically without storing reverse membership", async () => {
    const pool = makePool();
    const mutatePool = async (_id, mutator) => mutator(pool);
    await Promise.all([
      recordMihomoNodeEgress({ proxyPoolId: pool.id, route: { proxyProvider: "sub-a", nodeName: "Example Taiwan Node A" }, egress: mapping, mutatePool, nowMs: 1000 }),
      recordMihomoNodeEgress({ proxyPoolId: pool.id, route: { proxyProvider: "sub-b", nodeName: "Example Taiwan Node B" }, egress: mapping, mutatePool, nowMs: 1000 }),
    ]);

    expect(getMihomoNodeEgress(pool, { proxyProvider: "sub-a", nodeName: "Example Taiwan Node A" })).toMatchObject(mapping);
    expect(getMihomoNodeEgress(pool, { proxyProvider: "sub-b", nodeName: "Example Taiwan Node B" })).toMatchObject(mapping);
    expect(pool.mihomoState.egressIdentities).toEqual({});
    expect(isMihomoEgressFresh(mapping, 6000)).toBe(true);
    expect(isMihomoEgressFresh(mapping, 6001)).toBe(false);
  });

  it("provides provider-isolated identity state defaults", () => {
    const pool = makePool();
    expect(getMihomoEgressBusinessState(pool, "4:198.51.100.20", "opencode")).toEqual({
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: null,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
    });
  });
});
