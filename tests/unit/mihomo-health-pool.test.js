import { beforeEach, describe, expect, it } from "vitest";
import {
  buildHealthyMihomoSnapshot,
  clearHealthyMihomoSnapshots,
  getHealthyMihomoRuntime,
  publishHealthyMihomoSnapshot,
  rebuildHealthyMihomoSnapshot,
  reserveHealthyMihomoEgress,
} from "../../src/lib/network/mihomoHealthPool.js";

const NOW = 1_000_000;

function egress(identityKey) {
  const [family, ip] = identityKey.split(":");
  return {
    ip,
    family: Number(family),
    identityKey,
    confidence: "stable",
    observedAt: NOW,
    expiresAt: NOW + 100000,
    lastProbeAt: NOW,
    mappingVersion: 1,
  };
}

function makePool() {
  return {
    id: "health-pool",
    type: "mihomo",
    mihomoState: {
      version: 2,
      proxyProviders: {
        subscription: {
          nodes: {
            "Node A": { egress: egress("4:198.51.100.20"), transport: { status: "healthy" } },
            "Node B": { egress: egress("4:198.51.100.20"), transport: { status: "healthy" } },
            "Node C": { egress: egress("4:203.0.113.30"), transport: { status: "healthy" } },
          },
        },
      },
      egressIdentities: {
        "4:198.51.100.20": {
          models: {
            "opencode/model-a": {
              status: "healthy",
              refreshAt: NOW + 1000,
              expiresAt: NOW + 100000,
              evidenceVersion: 2,
            },
          },
        },
        "4:203.0.113.30": {
          models: {
            "opencode/model-a": {
              status: "healthy",
              refreshAt: NOW + 1000,
              expiresAt: NOW + 100000,
              evidenceVersion: 3,
            },
          },
        },
      },
      maintenance: {},
    },
  };
}

function directory() {
  return {
    nodes: [
      { key: "subscription\0Node A", proxyProvider: "subscription", nodeName: "Node A", alive: true, delayMs: 100 },
      { key: "subscription\0Node B", proxyProvider: "subscription", nodeName: "Node B", alive: null, delayMs: 200 },
      { key: "subscription\0Node C", proxyProvider: "subscription", nodeName: "Node C", alive: true, delayMs: 300 },
    ],
  };
}

beforeEach(() => {
  clearHealthyMihomoSnapshots();
});

describe("Mihomo immutable healthy pool", () => {
  it("merges same-IP nodes into one immutable egress entry", () => {
    const snapshot = rebuildHealthyMihomoSnapshot({
      pool: makePool(),
      directory: directory(),
      modelId: "opencode/model-a",
      nowMs: NOW,
    });

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0].nodes).toHaveLength(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0].nodes)).toBe(true);
  });

  it("reserves least-in-flight exits and then round-robins ties", async () => {
    const snapshot = rebuildHealthyMihomoSnapshot({
      pool: makePool(),
      directory: directory(),
      modelId: "opencode/model-a",
      nowMs: NOW,
    });
    const first = await reserveHealthyMihomoEgress({
      poolId: snapshot.poolId,
      modelId: snapshot.modelId,
      maxInFlightStartsPerEgress: 1,
      nowMs: NOW,
    });
    const second = await reserveHealthyMihomoEgress({
      poolId: snapshot.poolId,
      modelId: snapshot.modelId,
      maxInFlightStartsPerEgress: 1,
      nowMs: NOW,
    });

    expect(new Set([first.identityKey, second.identityKey]).size).toBe(2);
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(second.release()).toBe(true);
    expect(getHealthyMihomoRuntime({ poolId: snapshot.poolId, modelId: snapshot.modelId }))
      .toMatchObject({ inFlightStartsByEgress: {}, waiters: 0 });
  });

  it("waits FIFO for a released start slot and times out as saturated", async () => {
    const pool = makePool();
    const snapshot = buildHealthyMihomoSnapshot({
      pool,
      directory: { nodes: directory().nodes.slice(0, 1) },
      modelId: "opencode/model-a",
      nowMs: NOW,
    });
    publishHealthyMihomoSnapshot({ poolId: pool.id, modelId: "opencode/model-a", snapshot });
    const first = await reserveHealthyMihomoEgress({
      poolId: pool.id,
      modelId: "opencode/model-a",
      admissionWaitMs: 100,
      nowMs: NOW,
    });
    const waiting = reserveHealthyMihomoEgress({
      poolId: pool.id,
      modelId: "opencode/model-a",
      admissionWaitMs: 100,
      nowMs: NOW,
    });
    expect(getHealthyMihomoRuntime({ poolId: pool.id, modelId: "opencode/model-a" }).waiters).toBe(1);
    first.release();
    const second = await waiting;
    expect(second.identityKey).toBe(first.identityKey);
    second.release();

    const third = await reserveHealthyMihomoEgress({
      poolId: pool.id,
      modelId: "opencode/model-a",
      admissionWaitMs: 10,
      nowMs: NOW,
    });
    await expect(reserveHealthyMihomoEgress({
      poolId: pool.id,
      modelId: "opencode/model-a",
      admissionWaitMs: 10,
      nowMs: NOW,
    })).rejects.toMatchObject({ code: "MIHOMO_POOL_SATURATED" });
    third.release();
  });

  it("removes aborted waiters and keeps old snapshots unchanged after publish", async () => {
    const pool = makePool();
    const oldSnapshot = rebuildHealthyMihomoSnapshot({
      pool,
      directory: directory(),
      modelId: "opencode/model-a",
      nowMs: NOW,
    });
    const first = await reserveHealthyMihomoEgress({
      poolId: pool.id,
      modelId: "opencode/model-a",
      admissionWaitMs: 100,
      nowMs: NOW,
    });
    const controller = new AbortController();
    const waiting = reserveHealthyMihomoEgress({
      poolId: pool.id,
      modelId: "opencode/model-a",
      attemptedEgressKeys: new Set([oldSnapshot.entries[1].identityKey]),
      admissionWaitMs: 100,
      signal: controller.signal,
      nowMs: NOW,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(getHealthyMihomoRuntime({ poolId: pool.id, modelId: "opencode/model-a" }).waiters).toBe(0);

    const next = publishHealthyMihomoSnapshot({
      poolId: pool.id,
      modelId: "opencode/model-a",
      snapshot: {
        ...oldSnapshot,
        entries: oldSnapshot.entries.slice(1),
      },
    });
    expect(oldSnapshot.entries).toHaveLength(2);
    expect(next.entries).toHaveLength(1);
    first.release();
  });
});
