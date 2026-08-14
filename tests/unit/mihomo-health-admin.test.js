import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyMihomoState } from "../../src/lib/network/mihomoConfig.js";
import { rebuildHealthyMihomoSnapshot, clearHealthyMihomoSnapshots } from "../../src/lib/network/mihomoHealthPool.js";
import {
  buildMihomoHealthDto,
  MihomoHealthAdminError,
  validateMihomoHealthRefresh,
} from "../../src/lib/network/mihomoHealthAdmin.js";

function makePool() {
  const state = createEmptyMihomoState();
  state.maintenance = {
    ...state.maintenance,
    selectedModels: ["model-a", "model-b"],
    status: "probing-business",
    cycleId: "cycle-1",
    startedAt: 100,
    nodeCount: 2,
    mappedNodeCount: 2,
    distinctEgressCount: 2,
    totalBusinessChecks: 4,
    completedBusinessChecks: 2,
  };
  return {
    id: "health-pool",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://user:pass@router:18080",
    mihomo: { controllerSecret: "controller-secret" },
    mihomoState: state,
  };
}

function addNode(pool, nodeName, identityKey) {
  const ip = identityKey.slice(2);
  pool.mihomoState.proxyProviders.subscription ||= { nodes: {} };
  pool.mihomoState.proxyProviders.subscription.nodes[nodeName] = {
    egress: {
      ip,
      family: 4,
      identityKey,
      confidence: "stable",
      observedAt: 100,
      expiresAt: 9999999999999,
      mappingVersion: 1,
    },
    transport: { status: "healthy", consecutiveFailures: 0 },
  };
  pool.mihomoState.egressIdentities[identityKey] ||= { models: {} };
  return {
    key: `subscription\0${nodeName}`,
    proxyProvider: "subscription",
    nodeName,
    alive: true,
    delayMs: 120,
  };
}

function setHealth(pool, identityKey, modelId, value) {
  pool.mihomoState.egressIdentities[identityKey].models[modelId] = {
    refreshAt: null,
    expiresAt: null,
    cooldownUntil: null,
    backoffLevel: 0,
    lastStatus: null,
    lastErrorType: null,
    lastError: null,
    lastSuccessAt: null,
    evidenceVersion: 1,
    evidenceStartedAtMs: 100,
    source: "probe",
    ...value,
  };
}

beforeEach(() => clearHealthyMihomoSnapshots());

describe("Mihomo health DTO and refresh validation", () => {
  it("serializes the model×egress matrix from an allowlist", () => {
    const pool = makePool();
    const nodeA = addNode(pool, "Node A", "4:198.51.100.20");
    const nodeB = addNode(pool, "Node B", "4:198.51.100.21");
    setHealth(pool, "4:198.51.100.20", "model-a", {
      status: "healthy",
      refreshAt: 2000,
      expiresAt: 4000,
      lastSuccessAt: 1000,
    });
    setHealth(pool, "4:198.51.100.21", "model-a", {
      status: "cooling",
      cooldownUntil: 3000,
      lastErrorType: "HTTP_429",
      lastError: "rate limit",
    });
    setHealth(pool, "4:198.51.100.20", "model-b", {
      status: "healthy",
      refreshAt: 2000,
      expiresAt: 4000,
      lastSuccessAt: 1000,
    });
    rebuildHealthyMihomoSnapshot({
      pool,
      modelId: "model-a",
      directory: { nodes: [nodeA, nodeB] },
      nowMs: 1000,
    });

    const dto = buildMihomoHealthDto({ pool, nowMs: 1000 });
    expect(dto).toMatchObject({
      poolId: "health-pool",
      status: "healthy",
      cycle: {
        id: "cycle-1",
        status: "probing-business",
        nodes: { total: 2, mapped: 2 },
        egresses: { distinct: 2 },
      },
    });
    expect(dto.models[0]).toMatchObject({
      modelId: "model-a",
      healthyEgresses: 1,
      coolingEgresses: 1,
    });
    expect(dto.models[0].entries[0].nodes[0]).toMatchObject({
      proxyProvider: "subscription",
      role: "primary",
      transportStatus: "healthy",
    });
    expect(dto.models[0].entries[1]).toMatchObject({ status: "cooling", lastErrorType: "HTTP_429" });
    expect(Object.keys(dto).sort()).toEqual(["cycle", "models", "poolId", "status"]);
    expect(Object.keys(dto.models[0]).sort()).toEqual(["coolingEgresses", "entries", "healthyEgresses", "modelId", "refreshingEgresses"]);
    expect(Object.keys(dto.models[0].entries[0]).sort()).toEqual([
      "cooldownUntil",
      "exitIp",
      "expiresAt",
      "identityKey",
      "inFlightStarts",
      "lastError",
      "lastErrorType",
      "lastSuccessAt",
      "nodes",
      "refreshAt",
      "status",
    ]);
    expect(Object.keys(dto.models[0].entries[0].nodes[0]).sort()).toEqual([
      "alive",
      "delayMs",
      "nodeCooldownUntil",
      "nodeName",
      "proxyProvider",
      "role",
      "transportConsecutiveFailures",
      "transportCooling",
      "transportStatus",
    ]);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("controller-secret");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("mihomoState");
  });

  it("filters to a selected model and fails closed for invalid refresh scopes", () => {
    const pool = makePool();
    expect(buildMihomoHealthDto({ pool, modelId: "model-a", nowMs: 1000 }).models.map((model) => model.modelId))
      .toEqual(["model-a"]);
    expect(validateMihomoHealthRefresh({ pool, scope: "model", modelId: "model-a" }))
      .toEqual({ scope: "model", modelId: "model-a", identityKey: null });
    expect(validateMihomoHealthRefresh({ pool, scope: "egress", identityKey: "4:198.51.100.20" }))
      .toEqual({ scope: "egress", modelId: null, identityKey: "4:198.51.100.20" });
    expect(() => validateMihomoHealthRefresh({ pool, scope: "model" }))
      .toThrowError(new MihomoHealthAdminError("MIHOMO_INVALID_REQUEST", "modelId is invalid", 400));
    expect(() => validateMihomoHealthRefresh({ pool, scope: "model", modelId: "not-selected" }))
      .toThrowError(/not selected/);
    expect(() => validateMihomoHealthRefresh({ pool, scope: "egress" }))
      .toThrowError(/identityKey is invalid/);
    expect(() => buildMihomoHealthDto({ pool, modelId: "not-selected", nowMs: 1000 }))
      .toThrowError(/not selected/);
  });

  it("reports empty and warming pools without inventing model health", () => {
    const pool = makePool();
    pool.mihomoState.maintenance.selectedModels = [];
    expect(buildMihomoHealthDto({ pool, nowMs: 1000 })).toMatchObject({ status: "empty", models: [] });

    pool.mihomoState.maintenance.selectedModels = ["model-a"];
    expect(buildMihomoHealthDto({ pool, nowMs: 1000 })).toMatchObject({
      status: "warming",
      models: [{ modelId: "model-a", healthyEgresses: 0, refreshingEgresses: 0, coolingEgresses: 0, entries: [] }],
    });
  });
});
