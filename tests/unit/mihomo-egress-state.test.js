import { describe, expect, it } from "vitest";
import {
  getMihomoEgressBusinessState,
  getMihomoNodeEgress,
  isMihomoEgressFresh,
  migrateMihomoState,
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
      status: "unknown",
      refreshAt: null,
      expiresAt: null,
      cooldownUntil: null,
      backoffLevel: 0,
      lastStatus: null,
      lastErrorType: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
      evidenceVersion: 0,
      evidenceStartedAtMs: null,
      source: null,
    });
  });

  it("migrates v1 mappings while dropping model-less business evidence", () => {
    const migrated = migrateMihomoState({
      proxyProviders: {
        subscription: {
          nodes: {
            "Example Node": {
              egress: mapping,
              business: { opencode: { cooldownUntil: "2099-01-01T00:00:00.000Z" } },
            },
          },
        },
      },
      egressIdentities: {
        "4:198.51.100.20": {
          business: { opencode: { cooldownUntil: "2099-01-01T00:00:00.000Z" } },
        },
      },
    });

    expect(migrated.version).toBe(2);
    expect(migrated.proxyProviders.subscription.nodes["Example Node"]).toMatchObject({
      egress: { identityKey: mapping.identityKey, mappingVersion: 1 },
      transport: { status: "unknown", consecutiveFailures: 0 },
    });
    expect(migrated.proxyProviders.subscription.nodes["Example Node"].business).toBeUndefined();
    expect(migrated.egressIdentities["4:198.51.100.20"]).toBeUndefined();
  });

  it("rejects unsafe state keys during migration", () => {
    expect(() => migrateMihomoState({
      proxyProviders: { constructor: { nodes: {} } },
    })).toThrow(/safe state key/);
    expect(() => migrateMihomoState({
      proxyProviders: { subscription: { nodes: { prototype: {} } } },
    })).toThrow(/safe state key/);
  });
});
