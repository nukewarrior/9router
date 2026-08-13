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
    mihomo: { controllerUrl: "http://10.11.11.1:9090", selectorName: "selector" },
    mihomoState: { proxyProviders: {}, egressIdentities: {} },
  };
}

const mapping = {
  ip: "61.219.114.43",
  family: 4,
  identityKey: "4:61.219.114.43",
  confidence: "stable",
  observedIps: ["61.219.114.43"],
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
      recordMihomoNodeEgress({ proxyPoolId: pool.id, route: { proxyProvider: "sub-a", nodeName: "TW-A10" }, egress: mapping, mutatePool, nowMs: 1000 }),
      recordMihomoNodeEgress({ proxyPoolId: pool.id, route: { proxyProvider: "sub-b", nodeName: "TW-A11" }, egress: mapping, mutatePool, nowMs: 1000 }),
    ]);

    expect(getMihomoNodeEgress(pool, { proxyProvider: "sub-a", nodeName: "TW-A10" })).toMatchObject(mapping);
    expect(getMihomoNodeEgress(pool, { proxyProvider: "sub-b", nodeName: "TW-A11" })).toMatchObject(mapping);
    expect(pool.mihomoState.egressIdentities).toEqual({});
    expect(isMihomoEgressFresh(mapping, 6000)).toBe(true);
    expect(isMihomoEgressFresh(mapping, 6001)).toBe(false);
  });

  it("provides provider-isolated identity state defaults", () => {
    const pool = makePool();
    expect(getMihomoEgressBusinessState(pool, "4:61.219.114.43", "opencode")).toEqual({
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
