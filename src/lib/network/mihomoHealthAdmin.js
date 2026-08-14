import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import {
  getMihomoModelHealthState,
  migrateMihomoState,
} from "./mihomoState.js";
import {
  buildMihomoEgressGroupEntries,
  getHealthyMihomoRuntime,
  getHealthyMihomoSnapshot,
} from "./mihomoHealthPool.js";

const HEALTH_STATUSES = new Set(["healthy", "refreshing", "cooling", "degraded", "expired", "invalid", "warming"]);

export class MihomoHealthAdminError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MihomoHealthAdminError";
    this.code = code;
    this.status = status;
  }
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function safeKey(value, fieldName) {
  const key = text(value);
  if (!key || new Set(["__proto__", "constructor", "prototype"]).has(key) || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new MihomoHealthAdminError("MIHOMO_INVALID_REQUEST", `${fieldName} is invalid`, 400);
  }
  return key;
}

function finiteTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value) {
  const timestamp = finiteTime(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function redactError(value) {
  return text(value)
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]+@/giu, "$1")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\bsk-[a-z\d_-]{8,}\b/giu, "[redacted]")
    .slice(0, 500) || null;
}

function isTransportCooling(node, nowMs) {
  const cooldownUntil = finiteTime(node?.transportCooldownUntil);
  if (Number.isFinite(cooldownUntil)) return cooldownUntil > nowMs;
  return node?.transportStatus === "cooling";
}

function isActiveHealth(health, nowMs) {
  if (!health || !["healthy", "refreshing"].includes(health.status)) return false;
  const expiresAt = finiteTime(health.expiresAt);
  const cooldownUntil = finiteTime(health.cooldownUntil);
  return Number.isFinite(expiresAt)
    && expiresAt > nowMs
    && (!Number.isFinite(cooldownUntil) || cooldownUntil <= nowMs);
}

function entryStatus(health, nodes, snapshotEntry, nowMs) {
  const cooldownUntil = finiteTime(health?.cooldownUntil);
  if (health?.status === "invalid") return "invalid";
  if (health?.status === "cooling" && Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) return "cooling";
  const expiresAt = finiteTime(health?.expiresAt);
  if ((health?.status === "healthy" || health?.status === "refreshing")
    && (!Number.isFinite(expiresAt) || expiresAt <= nowMs)) return "expired";
  if (isActiveHealth(health, nowMs)) {
    if (!snapshotEntry || nodes.every((node) => isTransportCooling(node, nowMs))) return "degraded";
    if (nodes.some((node) => isTransportCooling(node, nowMs))) return "degraded";
    return health.status;
  }
  return "warming";
}

function publicNode(node, index, nowMs) {
  return {
    proxyProvider: node.proxyProvider,
    nodeName: node.nodeName,
    role: index === 0 ? "primary" : "backup",
    alive: node.alive,
    delayMs: node.delayMs,
    transportStatus: node.transportStatus || "unknown",
    nodeCooldownUntil: isoOrNull(node.transportCooldownUntil),
    transportConsecutiveFailures: node.transportConsecutiveFailures || 0,
    transportCooling: isTransportCooling(node, nowMs),
  };
}

function publicEntry({ group, health, snapshotEntry, inFlightStarts, nowMs }) {
  const status = entryStatus(health, group.nodes, snapshotEntry, nowMs);
  return {
    identityKey: group.identityKey,
    exitIp: group.ip || null,
    status: HEALTH_STATUSES.has(status) ? status : "warming",
    inFlightStarts,
    refreshAt: isoOrNull(health.refreshAt),
    expiresAt: isoOrNull(health.expiresAt),
    cooldownUntil: isoOrNull(health.cooldownUntil),
    lastSuccessAt: isoOrNull(health.lastSuccessAt),
    lastErrorType: text(health.lastErrorType) || null,
    lastError: redactError(health.lastError),
    nodes: group.nodes.map((node, index) => publicNode(node, index, nowMs)),
  };
}

function modelHealthDto({ pool, modelId, groups, nowMs }) {
  const snapshot = getHealthyMihomoSnapshot({ poolId: pool.id, modelId });
  const snapshotEntries = new Map((snapshot?.entries || []).map((entry) => [entry.identityKey, entry]));
  const runtime = getHealthyMihomoRuntime({ poolId: pool.id, modelId });
  const inFlight = runtime?.inFlightStartsByEgress || {};
  const entries = groups.map((group) => publicEntry({
    group,
    health: getMihomoModelHealthState(pool, group.identityKey, modelId),
    snapshotEntry: snapshotEntries.get(group.identityKey) || null,
    inFlightStarts: Math.max(0, Number(inFlight[group.identityKey]) || 0),
    nowMs,
  }));

  return {
    modelId,
    healthyEgresses: entries.filter((entry) => ["healthy", "degraded"].includes(entry.status)
      && snapshotEntries.has(entry.identityKey)).length,
    refreshingEgresses: entries.filter((entry) => entry.status === "refreshing" && snapshotEntries.has(entry.identityKey)).length,
    coolingEgresses: entries.filter((entry) => entry.status === "cooling").length,
    entries,
  };
}

function cycleDto(state) {
  return {
    id: text(state.cycleId) || null,
    status: text(state.status) || "idle",
    startedAt: isoOrNull(state.startedAt),
    completedAt: isoOrNull(state.completedAt),
    nextRunAt: isoOrNull(state.nextRunAt),
    nodes: {
      total: Math.max(0, Number(state.nodeCount) || 0),
      mapped: Math.max(0, Number(state.mappedNodeCount) || 0),
    },
    egresses: {
      distinct: Math.max(0, Number(state.distinctEgressCount) || 0),
    },
    businessChecks: {
      total: Math.max(0, Number(state.totalBusinessChecks) || 0),
      completed: Math.max(0, Number(state.completedBusinessChecks) || 0),
    },
  };
}

function poolStatus({ pool, state, models, modelDtos }) {
  if (pool.isActive !== true) return "inactive";
  if (models.length === 0 || (state.nodeCount === 0 && state.status === "complete")) return "empty";
  if (modelDtos.some((model) => model.healthyEgresses > 0 || model.refreshingEgresses > 0)) return "healthy";
  if (state.status === "degraded" || modelDtos.some((model) => model.coolingEgresses > 0)) return "degraded";
  return "warming";
}

export function buildMihomoHealthDto({ pool, modelId = null, nowMs = Date.now() } = {}) {
  if (!isMihomoProxyPool(pool)) {
    throw new MihomoHealthAdminError("MIHOMO_INVALID_CONFIG", "Selected proxy pool is not Mihomo managed", 400);
  }
  const state = migrateMihomoState(pool.mihomoState);
  const selectedModels = [...(state.maintenance.selectedModels || [])].sort();
  const requestedModelId = modelId === null ? null : safeKey(modelId, "modelId");
  if (requestedModelId !== null && !selectedModels.includes(requestedModelId)) {
    throw new MihomoHealthAdminError("MIHOMO_MODEL_NOT_MANAGED", "modelId is not selected for this Mihomo pool", 400);
  }
  const models = requestedModelId === null ? selectedModels : [requestedModelId];
  const groups = buildMihomoEgressGroupEntries({ pool, directory: null, nowMs });
  const modelDtos = models.map((selectedModelId) => modelHealthDto({ pool, modelId: selectedModelId, groups, nowMs }));
  return {
    poolId: pool.id,
    status: poolStatus({ pool, state: state.maintenance, models, modelDtos }),
    cycle: cycleDto(state.maintenance),
    models: modelDtos,
  };
}

export function validateMihomoHealthRefresh({ pool, scope, modelId = null, identityKey = null } = {}) {
  if (!isMihomoProxyPool(pool)) {
    throw new MihomoHealthAdminError("MIHOMO_INVALID_CONFIG", "Selected proxy pool is not Mihomo managed", 400);
  }
  if (pool.isActive !== true) {
    throw new MihomoHealthAdminError("MIHOMO_INVALID_CONFIG", "Mihomo proxy pool is inactive", 400);
  }
  const normalizedScope = text(scope) || "all";
  if (!["all", "inventory", "model", "egress"].includes(normalizedScope)) {
    throw new MihomoHealthAdminError("MIHOMO_INVALID_REQUEST", "scope must be all, inventory, model, or egress", 400);
  }
  const state = migrateMihomoState(pool.mihomoState);
  const selectedModels = new Set(state.maintenance.selectedModels || []);
  if (normalizedScope === "model") {
    const selectedModelId = safeKey(modelId, "modelId");
    if (!selectedModels.has(selectedModelId)) {
      throw new MihomoHealthAdminError("MIHOMO_MODEL_NOT_MANAGED", "modelId is not selected for this Mihomo pool", 400);
    }
  } else if (modelId !== null && modelId !== undefined && text(modelId)) {
    const selectedModelId = safeKey(modelId, "modelId");
    if (!selectedModels.has(selectedModelId)) {
      throw new MihomoHealthAdminError("MIHOMO_MODEL_NOT_MANAGED", "modelId is not selected for this Mihomo pool", 400);
    }
  }
  if (normalizedScope === "egress") safeKey(identityKey, "identityKey");
  return {
    scope: normalizedScope,
    modelId: modelId === null || modelId === undefined || !text(modelId) ? null : safeKey(modelId, "modelId"),
    identityKey: identityKey === null || identityKey === undefined || !text(identityKey) ? null : safeKey(identityKey, "identityKey"),
  };
}
