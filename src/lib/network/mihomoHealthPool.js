import {
  getMihomoNodeEgress,
  isMihomoStableEgress,
  migrateMihomoState,
} from "./mihomoState.js";

const snapshots = new Map();
const runtime = new Map();

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function poolModelKey(poolId, modelId) {
  const normalizedPoolId = text(poolId);
  const normalizedModelId = text(modelId);
  if (!normalizedPoolId || !normalizedModelId) {
    throw new TypeError("poolId and modelId are required");
  }
  return normalizedPoolId + "\0" + normalizedModelId;
}

function finiteTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && typeof value !== "string") return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneNode(node) {
  return {
    key: text(node?.key) || text(node?.proxyProvider) + "\0" + text(node?.nodeName),
    proxyProvider: text(node?.proxyProvider) || "__selector__",
    nodeName: text(node?.nodeName),
    region: text(node?.region) || "OTHER",
    alive: node?.alive === true ? true : node?.alive === false ? false : null,
    delayMs: Number.isFinite(Number(node?.delayMs)) ? Number(node.delayMs) : null,
    mappingVersion: Math.max(0, Math.floor(Number(node?.egress?.mappingVersion ?? node?.mappingVersion) || 0)),
    transportStatus: text(node?.transportStatus) || "unknown",
    transportCooldownUntil: node?.transportCooldownUntil ?? null,
    transportLastSuccessAt: node?.transportLastSuccessAt ?? null,
    transportConsecutiveFailures: Math.max(0, Math.floor(Number(node?.transportConsecutiveFailures) || 0)),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createRuntime(key) {
  let current = runtime.get(key);
  if (current) return current;
  current = {
    revision: 0,
    roundRobinCursor: 0,
    maxInFlightStartsPerEgress: 1,
    inFlightStartsByEgress: new Map(),
    waiters: [],
  };
  runtime.set(key, current);
  return current;
}

function modelHealth(state, identityKey, modelId) {
  return state.egressIdentities?.[identityKey]?.models?.[modelId] || null;
}

function isModelHealthEligible(health, nowMs) {
  if (!health || !["healthy", "refreshing"].includes(health.status)) return false;
  const expiresAt = finiteTime(health.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;
  const cooldownUntil = finiteTime(health.cooldownUntil);
  return !Number.isFinite(cooldownUntil) || cooldownUntil <= nowMs;
}

function nodeState(state, node) {
  return state.proxyProviders?.[node.proxyProvider]?.nodes?.[node.nodeName] || {};
}

function nodeTransportCooling(transport, nowMs) {
  const cooldownUntil = finiteTime(transport?.cooldownUntil);
  if (Number.isFinite(cooldownUntil)) return cooldownUntil > nowMs;
  return transport?.status === "cooling";
}

function directoryNodes(pool, directory) {
  if (Array.isArray(directory?.nodes)) return directory.nodes;
  const state = migrateMihomoState(pool?.mihomoState);
  const nodes = [];
  for (const [proxyProvider, providerState] of Object.entries(state.proxyProviders || {})) {
    for (const [nodeName, nodeStateValue] of Object.entries(providerState?.nodes || {})) {
      nodes.push({
        key: proxyProvider + "\0" + nodeName,
        proxyProvider,
        nodeName,
        alive: null,
        delayMs: null,
        egress: nodeStateValue?.egress || null,
      });
    }
  }
  return nodes;
}

function sortNodes(nodes, nowMs = Date.now()) {
  return [...nodes].sort((left, right) => (
    (left.alive === true ? 0 : left.alive === null ? 1 : 2)
      - (right.alive === true ? 0 : right.alive === null ? 1 : 2)
    || (nodeTransportCooling({
      status: left.transportStatus,
      cooldownUntil: left.transportCooldownUntil,
    }, nowMs) ? 1 : 0)
      - (nodeTransportCooling({
        status: right.transportStatus,
        cooldownUntil: right.transportCooldownUntil,
      }, nowMs) ? 1 : 0)
    || (finiteTime(right.transportLastSuccessAt) ?? Number.NEGATIVE_INFINITY)
      - (finiteTime(left.transportLastSuccessAt) ?? Number.NEGATIVE_INFINITY)
    || left.transportConsecutiveFailures - right.transportConsecutiveFailures
    || ((Number.isFinite(Number(left.delayMs)) ? Number(left.delayMs) : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(Number(right.delayMs)) ? Number(right.delayMs) : Number.MAX_SAFE_INTEGER))
    || left.key.localeCompare(right.key)
  ));
}

function buildSnapshotValue({ pool, directory, modelId, nowMs }) {
  const state = migrateMihomoState(pool?.mihomoState);
  const grouped = new Map();

  for (const directoryNode of directoryNodes(pool, directory)) {
    const egress = getMihomoNodeEgress(pool, directoryNode);
    if (!isMihomoStableEgress(egress, nowMs)) continue;
    const health = modelHealth(state, egress.identityKey, modelId);
    if (!isModelHealthEligible(health, nowMs)) continue;

    const persistedNode = nodeState(state, directoryNode);
    const transport = persistedNode.transport || {};
    const normalizedNode = cloneNode({
      ...directoryNode,
      egress,
      transportStatus: transport.status || "unknown",
      transportCooldownUntil: transport.cooldownUntil || null,
      transportLastSuccessAt: transport.lastSuccessAt || null,
      transportConsecutiveFailures: transport.consecutiveFailures || 0,
    });
    const group = grouped.get(egress.identityKey) || {
      identityKey: egress.identityKey,
      ip: egress.ip,
      family: egress.family,
      health,
      nodes: [],
    };
    group.nodes.push(normalizedNode);
    grouped.set(egress.identityKey, group);
  }

  const entries = [...grouped.values()]
    .map((group) => {
      const nodes = sortNodes(group.nodes, nowMs);
      const usableNodes = nodes.filter((node) => !nodeTransportCooling({
        status: node.transportStatus,
        cooldownUntil: node.transportCooldownUntil,
      }, nowMs));
      return {
        identityKey: group.identityKey,
        ip: group.ip,
        family: group.family,
        refreshAt: group.health.refreshAt ?? null,
        expiresAt: group.health.expiresAt ?? null,
        evidenceVersion: Math.max(0, Math.floor(Number(group.health.evidenceVersion) || 0)),
        nodes,
        usableNodeCount: usableNodes.length,
      };
    })
    .filter((entry) => entry.usableNodeCount > 0)
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
    .map(({ usableNodeCount, ...entry }) => entry);

  return {
    poolId: pool.id,
    modelId,
    entries,
  };
}

export function buildMihomoEgressGroupEntries({ pool, directory = null, nowMs = Date.now() } = {}) {
  const grouped = new Map();
  const state = migrateMihomoState(pool?.mihomoState);
  for (const directoryNode of directoryNodes(pool, directory)) {
    const egress = getMihomoNodeEgress(pool, directoryNode);
    if (!isMihomoStableEgress(egress, nowMs)) continue;
    const persistedNode = nodeState(state, directoryNode);
    const transport = persistedNode.transport || {};
    const normalizedNode = cloneNode({
      ...directoryNode,
      egress,
      transportStatus: transport.status || "unknown",
      transportCooldownUntil: transport.cooldownUntil || null,
      transportLastSuccessAt: transport.lastSuccessAt || null,
      transportConsecutiveFailures: transport.consecutiveFailures || 0,
    });
    const group = grouped.get(egress.identityKey) || {
      identityKey: egress.identityKey,
      ip: egress.ip,
      family: egress.family,
      nodes: [],
    };
    group.nodes.push(normalizedNode);
    grouped.set(egress.identityKey, group);
  }
  return [...grouped.values()]
    .map((group) => ({ ...group, nodes: sortNodes(group.nodes, nowMs) }))
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
}

export function buildHealthyMihomoSnapshot({ pool, directory = null, modelId, nowMs = Date.now() } = {}) {
  if (!pool?.id) throw new TypeError("pool.id is required");
  const key = poolModelKey(pool.id, modelId);
  const current = runtime.get(key);
  const value = buildSnapshotValue({ pool, directory, modelId: text(modelId), nowMs });
  return deepFreeze({
    key,
    poolId: pool.id,
    modelId: text(modelId),
    revision: (current?.revision || 0) + 1,
    publishedAt: nowMs,
    entries: value.entries,
  });
}

function ensureSnapshotRevision(snapshot, key, current) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!value || !Array.isArray(value.entries)) throw new TypeError("healthy pool snapshot is invalid");
  return deepFreeze({
    key,
    poolId: text(value.poolId),
    modelId: text(value.modelId),
    revision: Math.max((current?.revision || 0) + 1, Math.floor(Number(value.revision) || 0)),
    publishedAt: value.publishedAt ?? Date.now(),
    entries: value.entries,
  });
}

function poolError(code, message) {
  const error = new Error(message);
  error.name = "MihomoHealthPoolError";
  error.code = code;
  return error;
}

function rejectWaiter(waiter, error) {
  if (waiter.done) return;
  waiter.done = true;
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
  waiter.reject(error);
}

function removeWaiter(state, waiter) {
  const index = state.waiters.indexOf(waiter);
  if (index >= 0) state.waiters.splice(index, 1);
}

function availableEntries(snapshot, state, attemptedEgressKeys, nowMs, preferredEgressKey = null) {
  const attempted = attemptedEgressKeys instanceof Set ? attemptedEgressKeys : new Set(attemptedEgressKeys || []);
  const eligible = snapshot.entries.filter((entry) => {
    if (attempted.has(entry.identityKey)) return false;
    if (finiteTime(entry.expiresAt) <= nowMs) return false;
    const hasUsableNode = entry.nodes.some((node) => !nodeTransportCooling({
      status: node.transportStatus,
      cooldownUntil: node.transportCooldownUntil,
    }, nowMs));
    if (!hasUsableNode) return false;
    return (state.inFlightStartsByEgress.get(entry.identityKey) || 0) < state.maxInFlightStartsPerEgress;
  });
  if (!preferredEgressKey) return eligible;
  const preferred = eligible.filter((entry) => entry.identityKey === preferredEgressKey);
  if (preferred.length > 0) return preferred;

  // Keep a valid but saturated preferred group preferred until its short
  // admission wait ends. If the group has disappeared or is no longer
  // usable, normal distinct-egress selection may continue.
  const preferredExists = snapshot.entries.some((entry) => (
    entry.identityKey === preferredEgressKey
      && !attempted.has(entry.identityKey)
      && finiteTime(entry.expiresAt) > nowMs
      && entry.nodes.some((node) => !nodeTransportCooling({
        status: node.transportStatus,
        cooldownUntil: node.transportCooldownUntil,
      }, nowMs))
  ));
  return preferredExists ? [] : eligible;
}

function snapshotHasUnattemptedEntry(snapshot, attemptedEgressKeys, nowMs) {
  const attempted = attemptedEgressKeys instanceof Set ? attemptedEgressKeys : new Set(attemptedEgressKeys || []);
  return snapshot.entries.some((entry) => !attempted.has(entry.identityKey) && finiteTime(entry.expiresAt) > nowMs);
}

function chooseEntry(snapshot, state, attemptedEgressKeys, nowMs, preferredEgressKey = null) {
  const candidates = availableEntries(snapshot, state, attemptedEgressKeys, nowMs, preferredEgressKey);
  if (candidates.length === 0) return null;
  const minimum = Math.min(...candidates.map((entry) => state.inFlightStartsByEgress.get(entry.identityKey) || 0));
  const least = candidates.filter((entry) => (state.inFlightStartsByEgress.get(entry.identityKey) || 0) === minimum);
  const selected = least[state.roundRobinCursor % least.length];
  const sortedIndex = snapshot.entries.findIndex((entry) => entry.identityKey === selected.identityKey);
  state.roundRobinCursor = (Math.max(sortedIndex, 0) + 1) % Math.max(snapshot.entries.length, 1);
  return selected;
}

function cleanupRuntime(key) {
  const state = runtime.get(key);
  if (!state) return;
  if (state.waiters.length > 0) return;
  if ([...state.inFlightStartsByEgress.values()].some((count) => count > 0)) return;
  if (snapshots.has(key)) return;
  runtime.delete(key);
}

function wakeWaiters(key) {
  const state = runtime.get(key);
  const snapshot = snapshots.get(key);
  if (!state || !snapshot || state.waiters.length === 0) return;
  for (const waiter of [...state.waiters]) {
    if (waiter.done) {
      removeWaiter(state, waiter);
      continue;
    }
    const reservation = tryReserve(state, snapshot, waiter.options);
    if (!reservation) continue;
    removeWaiter(state, waiter);
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
    waiter.resolve(reservation);
  }
  cleanupRuntime(key);
}

function createReservation(snapshot, state, entry) {
  const previous = state.inFlightStartsByEgress.get(entry.identityKey) || 0;
  state.inFlightStartsByEgress.set(entry.identityKey, previous + 1);
  let released = false;
  const reservation = {
    snapshot,
    entry,
    identityKey: entry.identityKey,
    release() {
      if (released) return false;
      released = true;
      const current = state.inFlightStartsByEgress.get(entry.identityKey) || 0;
      if (current <= 1) state.inFlightStartsByEgress.delete(entry.identityKey);
      else state.inFlightStartsByEgress.set(entry.identityKey, current - 1);
      wakeWaiters(snapshot.key);
      cleanupRuntime(snapshot.key);
      return true;
    },
  };
  return Object.freeze(reservation);
}

function tryReserve(state, snapshot, options) {
  state.maxInFlightStartsPerEgress = Math.max(
    1,
    Math.floor(Number(options.maxInFlightStartsPerEgress) || 1),
  );
  const entry = chooseEntry(
    snapshot,
    state,
    options.attemptedEgressKeys,
    options.nowMs,
    options.preferredEgressKey,
  );
  return entry ? createReservation(snapshot, state, entry) : null;
}

export function getHealthyMihomoSnapshot({ poolId, modelId } = {}) {
  return snapshots.get(poolModelKey(poolId, modelId)) || null;
}

export function getHealthyMihomoRuntime({ poolId, modelId } = {}) {
  const state = runtime.get(poolModelKey(poolId, modelId));
  if (!state) return null;
  return {
    revision: state.revision,
    roundRobinCursor: state.roundRobinCursor,
    inFlightStartsByEgress: Object.fromEntries(state.inFlightStartsByEgress),
    waiters: state.waiters.length,
  };
}

export function publishHealthyMihomoSnapshot({ poolId, modelId, snapshot, pool, directory = null, nowMs = Date.now() } = {}) {
  const key = poolModelKey(poolId, modelId);
  const state = createRuntime(key);
  const next = snapshot
    ? ensureSnapshotRevision(snapshot, key, state)
    : buildHealthyMihomoSnapshot({ pool: { ...pool, id: poolId }, directory, modelId, nowMs });
  state.revision = next.revision;
  snapshots.set(key, next);
  wakeWaiters(key);
  return next;
}

export function rebuildHealthyMihomoSnapshot({ pool, directory = null, modelId, nowMs = Date.now() } = {}) {
  return publishHealthyMihomoSnapshot({
    poolId: pool?.id,
    modelId,
    pool,
    directory,
    nowMs,
  });
}

export function clearHealthyMihomoSnapshot({ poolId, modelId } = {}) {
  const key = poolModelKey(poolId, modelId);
  const state = runtime.get(key);
  const snapshot = snapshots.get(key) || null;
  snapshots.delete(key);
  if (state) {
    for (const waiter of [...state.waiters]) {
      rejectWaiter(waiter, poolError("MIHOMO_POOL_REMOVED", "Mihomo healthy pool was removed"));
    }
    state.waiters.length = 0;
  }
  cleanupRuntime(key);
  return snapshot;
}

export function clearHealthyMihomoPool(poolId) {
  const prefix = text(poolId) + "\0";
  for (const key of [...snapshots.keys()]) {
    if (key.startsWith(prefix)) {
      clearHealthyMihomoSnapshot({ poolId, modelId: key.slice(prefix.length) });
    }
  }
}

export function clearHealthyMihomoSnapshots() {
  for (const key of [...snapshots.keys()]) {
    const separator = key.indexOf("\0");
    clearHealthyMihomoSnapshot({ poolId: key.slice(0, separator), modelId: key.slice(separator + 1) });
  }
  snapshots.clear();
  runtime.clear();
}

export function reserveHealthyMihomoEgress({
  poolId,
  modelId,
  attemptedEgressKeys = new Set(),
  signal = null,
  admissionWaitMs = 3000,
  maxInFlightStartsPerEgress = 1,
  preferredEgressKey = null,
  nowMs = Date.now(),
} = {}) {
  const key = poolModelKey(poolId, modelId);
  const snapshot = snapshots.get(key);
  if (!snapshot) throw poolError("MIHOMO_POOL_WARMING", "Mihomo healthy pool is warming");
  const state = createRuntime(key);
  const options = {
    attemptedEgressKeys,
    preferredEgressKey,
    maxInFlightStartsPerEgress,
    nowMs,
  };
  const reservation = tryReserve(state, snapshot, options);
  if (reservation) return Promise.resolve(reservation);

  const hasUnattempted = snapshotHasUnattemptedEntry(snapshot, attemptedEgressKeys, nowMs);
  if (!hasUnattempted) {
    throw poolError("MIHOMO_POOL_EXHAUSTED", "No unattempted Mihomo egress is available");
  }
  const waitMs = Math.max(0, Math.floor(Number(admissionWaitMs) || 0));
  if (waitMs === 0) throw poolError("MIHOMO_POOL_SATURATED", "Mihomo healthy pool is saturated");

  return new Promise((resolve, reject) => {
    const waiter = {
      options,
      resolve,
      reject,
      done: false,
      timer: null,
      signal,
      onAbort: null,
    };
    waiter.onAbort = () => {
      removeWaiter(state, waiter);
      rejectWaiter(waiter, poolError("ABORT_ERR", "Mihomo pool reservation was aborted"));
      cleanupRuntime(key);
    };
    if (signal?.aborted) {
      waiter.onAbort();
      return;
    }
    signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
    waiter.timer = setTimeout(() => {
      removeWaiter(state, waiter);
      rejectWaiter(waiter, poolError("MIHOMO_POOL_SATURATED", "Mihomo healthy pool is saturated"));
      cleanupRuntime(key);
    }, waitMs);
    if (typeof waiter.timer?.unref === "function") waiter.timer.unref();
    state.waiters.push(waiter);
  });
}

export function getHealthyMihomoSnapshotRegistrySize() {
  return snapshots.size;
}
