import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMihomoRotationState,
  getMihomoEgressCandidateKey,
  groupMihomoNodesByEgress,
  prepareMihomoRouteAttempt,
} from "../../src/lib/network/mihomoRouteManager.js";
import {
  clearHealthyMihomoSnapshots,
  rebuildHealthyMihomoSnapshot,
} from "../../src/lib/network/mihomoHealthPool.js";
import { createEmptyMihomoState } from "../../src/lib/network/mihomoConfig.js";

const NOW = 1000;

function makePool(id = "egress-route") {
  const state = createEmptyMihomoState();
  state.maintenance.selectedModels = ["model-a"];
  state.maintenance.nodeCount = 2;
  return {
    id,
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18081",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      maxAttemptsPerRequest: 4,
      admissionWaitMs: 0,
    },
    mihomoState: state,
  };
}

function addNode(pool, nodeName, identityKey, provider = "sub-a") {
  const ip = identityKey.slice(2);
  pool.mihomoState.proxyProviders[provider] ||= { nodes: {} };
  pool.mihomoState.proxyProviders[provider].nodes[nodeName] = {
    egress: {
      ip,
      family: 4,
      identityKey,
      confidence: "stable",
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 100,
      expiresAt: 9999999999999,
      lastProbeAt: 100,
      lastProbeError: null,
      needsProbe: false,
      mappingVersion: 1,
    },
    transport: { status: "healthy", consecutiveFailures: 0 },
  };
  pool.mihomoState.egressIdentities[identityKey] ||= { models: {} };
  pool.mihomoState.egressIdentities[identityKey].models["model-a"] = {
    status: "healthy",
    refreshAt: new Date(NOW + 60000).toISOString(),
    expiresAt: new Date(NOW + 300000).toISOString(),
    cooldownUntil: null,
    evidenceVersion: 2,
    evidenceStartedAtMs: 100,
    lastSuccessAt: new Date(100).toISOString(),
    source: "probe",
  };
  return {
    key: `${provider}\0${nodeName}`,
    proxyProvider: provider,
    nodeName,
    region: "OTHER",
    alive: true,
    delayMs: 10,
  };
}

function context() {
  return {
    attemptedEgressKeys: new Set(),
    attemptedNodeKeysByEgress: new Map(),
    attempts: 0,
  };
}

function publish(pool, nodes) {
  return rebuildHealthyMihomoSnapshot({
    pool,
    modelId: "model-a",
    directory: { selectorName: "selector", nodes },
    nowMs: NOW,
  });
}

beforeEach(() => {
  clearMihomoRotationState();
  clearHealthyMihomoSnapshots();
});

describe("Mihomo egress snapshot routing", () => {
  it("groups stable same-IP nodes and keeps unknown mappings node-scoped", () => {
    const nodes = [
      {
        key: "sub-a\0Node A",
        nodeName: "Node A",
        proxyProvider: "sub-a",
        egress: { ip: "192.0.2.20", family: 4, confidence: "stable", identityKey: "4:192.0.2.20", expiresAt: 9999 },
      },
      {
        key: "sub-b\0Node B",
        nodeName: "Node B",
        proxyProvider: "sub-b",
        egress: { ip: "192.0.2.20", family: 4, confidence: "stable", identityKey: "4:192.0.2.20", expiresAt: 9999 },
      },
      {
        key: "sub-a\0Node C",
        nodeName: "Node C",
        proxyProvider: "sub-a",
        egress: null,
      },
    ];
    const groups = groupMihomoNodesByEgress(nodes, NOW);
    expect(groups.get("4:192.0.2.20").map((node) => node.nodeName)).toEqual(["Node A", "Node B"]);
    expect(groups.get("node:sub-a\0Node C")).toHaveLength(1);
    expect(getMihomoEgressCandidateKey(nodes[2], NOW)).toBe("node:sub-a\0Node C");
  });

  it("selects only published healthy snapshot entries without Controller discovery", async () => {
    const pool = makePool();
    const nodes = [
      addNode(pool, "Taiwan Node", "4:192.0.2.20"),
      addNode(pool, "Japan Node", "4:192.0.2.21"),
    ];
    publish(pool, nodes);
    const result = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      modelId: "model-a",
      routeContext: context(),
      getPool: async () => pool,
      makeClient: () => { throw new Error("request route must not discover Mihomo directory"); },
      nowMs: NOW,
    });

    expect(result.route.egressIdentityKey).toMatch(/^4:/);
    expect(result.route.modelId).toBe("model-a");
    expect(result.route.egressSnapshot.scopeEligible).toBe(true);
    result.reservation.release();
  });

  it("uses the preferred same-egress entry for a backup without consuming an exit attempt", async () => {
    const pool = makePool("backup");
    const nodes = [
      addNode(pool, "Node A1", "4:192.0.2.30"),
      addNode(pool, "Node A2", "4:192.0.2.30"),
      addNode(pool, "Node B", "4:192.0.2.31"),
    ];
    publish(pool, nodes);
    const routeContext = context();
    const first = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      modelId: "model-a",
      routeContext,
      getPool: async () => pool,
      nowMs: NOW,
    });
    first.reservation.release();
    routeContext.preferredEgressKey = first.route.egressIdentityKey;
    const second = await prepareMihomoRouteAttempt({
      poolId: pool.id,
      modelId: "model-a",
      routeContext,
      getPool: async () => pool,
      nowMs: NOW,
    });

    expect(first.route.egressIdentityKey).toBe("4:192.0.2.30");
    expect(second.route.egressIdentityKey).toBe("4:192.0.2.30");
    expect(second.route.nodeName).toBe("Node A2");
    expect(routeContext.attempts).toBe(2 - 0);
    second.reservation.release();
  });
});
