import { randomUUID } from "node:crypto";
import {
  getCustomModels,
  getProxyPoolById,
  getProxyPools,
  mutateProxyPool,
} from "@/models";
import { createMihomoClient } from "./mihomoClient.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import {
  buildMihomoNodeDirectory,
  getMihomoModelHealthState,
  getMihomoNodeEgress,
  isMihomoEgressFresh,
  isMihomoStableEgress,
  migrateMihomoState,
} from "./mihomoState.js";
import {
  buildMihomoEgressGroupEntries,
  clearHealthyMihomoPool,
  clearHealthyMihomoSnapshot,
  rebuildHealthyMihomoSnapshot,
} from "./mihomoHealthPool.js";
import { probeMihomoBusinessEgress } from "./mihomoBusinessProbe.js";
import { probeMihomoNodeEgress } from "./mihomoEgressDiscovery.js";
import {
  createMihomoMaintenanceScheduler,
  getMihomoMaintenanceJobKey,
  MIHOMO_MAINTENANCE_PRIORITY,
} from "./mihomoMaintenanceScheduler.js";

const DEFAULT_TICK_MS = 60000;
const TRANSPORT_FAILURE_STATUS = new Set(["cooling"]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function safeStateKey(value) {
  const key = text(value);
  return key
    && !new Set(["__proto__", "constructor", "prototype"]).has(key)
    && !/[\u0000-\u001f\u007f]/.test(key)
    ? key
    : null;
}

function cloneModels(models) {
  return [...new Set((Array.isArray(models) ? models : [])
    .map((modelId) => text(modelId))
    .filter(Boolean))].sort();
}

function sameModels(left, right) {
  const a = cloneModels(left);
  const b = cloneModels(right);
  return a.length === b.length && a.every((modelId, index) => modelId === b[index]);
}

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function finiteTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function redactError(value) {
  return text(value)
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]+@/giu, "$1")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .slice(0, 500);
}

function errorMessage(error) {
  return redactError(error?.message || error) || "Mihomo maintenance cycle failed";
}

function isActiveMihomoPool(pool) {
  return Boolean(pool && pool.isActive === true && isMihomoProxyPool(pool));
}

function selectorKey(config) {
  return `${config.controllerUrl}\0${config.selectorName}`;
}

function nodeKey(node) {
  return text(node?.key)
    || `${text(node?.proxyProvider) || "__selector__"}\0${text(node?.nodeName)}`;
}

function directoryKeySet(directory) {
  return new Set((Array.isArray(directory?.nodes) ? directory.nodes : [])
    .map(nodeKey)
    .filter(Boolean));
}

function configFingerprint(config) {
  return JSON.stringify(config);
}

function mappingVersion(pool, node) {
  return Math.max(0, Math.floor(Number(getMihomoNodeEgress(pool, node)?.mappingVersion) || 0));
}

function isTransportCooling(node, nowMs) {
  const status = text(node?.transportStatus);
  const cooldownUntil = finiteTime(node?.transportCooldownUntil);
  return TRANSPORT_FAILURE_STATUS.has(status)
    || (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs);
}

function egressProbeRank(node, nowMs, ttlMs) {
  const egress = node?.egress;
  if (!egress || egress.needsProbe === true || egress.confidence === "unknown") return 0;
  if (!isMihomoEgressFresh(egress, nowMs)) return 1;
  const expiresAt = Number(egress.expiresAt);
  const refreshWindow = Math.min(1800000, Math.max(60000, Number(ttlMs) || 21600000) * 0.2);
  if (Number.isFinite(expiresAt) && expiresAt - nowMs <= refreshWindow) return 2;
  if (egress.lastProbeError) return 3;
  return 4;
}

function evidenceTime(health) {
  const explicit = finiteTime(health?.evidenceStartedAtMs);
  if (Number.isFinite(explicit)) return explicit;
  const success = finiteTime(health?.lastSuccessAt);
  return Number.isFinite(success) ? success : Number.NEGATIVE_INFINITY;
}

function isHealthyForCount(health, nowMs) {
  if (!health || !["healthy", "refreshing"].includes(health.status)) return false;
  const expiresAt = finiteTime(health.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;
  const cooldownUntil = finiteTime(health.cooldownUntil);
  return !Number.isFinite(cooldownUntil) || cooldownUntil <= nowMs;
}

function currentHealthyCounts(pool, models, groups, nowMs) {
  return Object.fromEntries(models.map((modelId) => [
    modelId,
    groups.reduce((count, group) => count + (
      isHealthyForCount(getMihomoModelHealthState(pool, group.identityKey, modelId), nowMs) ? 1 : 0
    ), 0),
  ]));
}

function chooseBusinessCombination({ pool, models, groups, checked, nowMs }) {
  const candidates = [];
  for (const modelId of models) {
    const availableGroups = groups.filter((group) => !checked.has(`${modelId}\0${group.identityKey}`));
    if (availableGroups.length === 0) continue;
    const totalHealthy = groups.reduce((count, group) => count + (
      isHealthyForCount(getMihomoModelHealthState(pool, group.identityKey, modelId), nowMs) ? 1 : 0
    ), 0);
    const selectedGroup = [...availableGroups].sort((left, right) => {
      const leftHealth = getMihomoModelHealthState(pool, left.identityKey, modelId);
      const rightHealth = getMihomoModelHealthState(pool, right.identityKey, modelId);
      return evidenceTime(leftHealth) - evidenceTime(rightHealth)
        || left.identityKey.localeCompare(right.identityKey);
    })[0];
    candidates.push({
      modelId,
      group: selectedGroup,
      totalHealthy,
    });
  }
  candidates.sort((left, right) => (
    left.totalHealthy - right.totalHealthy
      || left.modelId.localeCompare(right.modelId)
      || left.group.identityKey.localeCompare(right.group.identityKey)
  ));
  return candidates[0] || null;
}

function createGuardedMutation({
  poolId,
  mutate,
  isCurrent,
}) {
  return (id, mutator) => mutate(id, (current) => {
    if (id !== poolId || !isCurrent(current)) return current;
    return mutator(current);
  });
}

function validDirectoryNode(node) {
  return Boolean(safeStateKey(node?.proxyProvider || "__selector__") && safeStateKey(node?.nodeName));
}

function persistInventoryState(current, directory) {
  const state = migrateMihomoState(current?.mihomoState);
  const currentNodes = new Set((Array.isArray(directory?.nodes) ? directory.nodes : [])
    .filter(validDirectoryNode)
    .map(nodeKey));

  for (const [providerName, providerState] of Object.entries(state.proxyProviders || {})) {
    for (const nodeName of Object.keys(providerState?.nodes || {})) {
      if (!currentNodes.has(`${providerName}\0${nodeName}`)) delete providerState.nodes[nodeName];
    }
    if (Object.keys(providerState?.nodes || {}).length === 0) delete state.proxyProviders[providerName];
  }

  for (const node of Array.isArray(directory?.nodes) ? directory.nodes : []) {
    const providerName = safeStateKey(node.proxyProvider || "__selector__");
    const name = safeStateKey(node.nodeName);
    if (!providerName || !name) continue;
    if (!state.proxyProviders[providerName]) state.proxyProviders[providerName] = { nodes: {} };
    if (!state.proxyProviders[providerName].nodes[name]) {
      state.proxyProviders[providerName].nodes[name] = {
        egress: null,
        transport: {
          status: "unknown",
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastErrorType: null,
          lastError: null,
        },
      };
    }
  }
  return state;
}

export function selectMihomoMaintenanceModels(models = []) {
  return cloneModels((Array.isArray(models) ? models : [])
    .filter((model) => model?.providerAlias === "oc" && (model.type || "llm") === "llm")
    .map((model) => model?.id));
}

async function defaultLoadSelectedModels(getModels) {
  return selectMihomoMaintenanceModels(await getModels());
}

export function createMihomoMaintenanceService({
  getPools = getProxyPools,
  getPool = getProxyPoolById,
  getModels = getCustomModels,
  mutate = mutateProxyPool,
  makeClient = createMihomoClient,
  probeEgress = probeMihomoNodeEgress,
  probeBusiness = probeMihomoBusinessEgress,
  scheduler = createMihomoMaintenanceScheduler(),
  now = Date.now,
  schedule = setInterval,
  cancelSchedule = clearInterval,
  tickMs = DEFAULT_TICK_MS,
  createCycleId = randomUUID,
} = {}) {
  const pools = new Map();
  let started = false;
  let tickHandle = null;
  let startPromise = null;

  async function loadSelectedModels() {
    return defaultLoadSelectedModels(getModels);
  }

  async function updateMaintenance(poolId, updates) {
    return mutate(poolId, (current) => {
      if (!current?.mihomo || typeof current.mihomo !== "object") return current;
      const state = migrateMihomoState(current.mihomoState);
      state.maintenance = {
        ...state.maintenance,
        ...updates,
        selectedModels: cloneModels(updates.selectedModels ?? state.maintenance.selectedModels),
        healthyByModel: updates.healthyByModel || state.maintenance.healthyByModel || {},
      };
      current.mihomoState = state;
      return current;
    });
  }

  async function pruneDeletedModels(poolId, selectedModels) {
    const allowed = new Set(selectedModels);
    return mutate(poolId, (current) => {
      if (!current?.mihomo || typeof current.mihomo !== "object") return current;
      const state = migrateMihomoState(current.mihomoState);
      for (const [identityKey, identityState] of Object.entries(state.egressIdentities || {})) {
        for (const modelId of Object.keys(identityState?.models || {})) {
          if (!allowed.has(modelId)) delete identityState.models[modelId];
        }
        if (Object.keys(identityState?.models || {}).length === 0) delete state.egressIdentities[identityKey];
      }
      state.maintenance.selectedModels = [...selectedModels];
      current.mihomoState = state;
      return current;
    });
  }

  function clearRemovedModelSnapshots(poolId, previousModels, selectedModels) {
    const allowed = new Set(selectedModels);
    for (const modelId of previousModels || []) {
      if (!allowed.has(modelId)) clearHealthyMihomoSnapshot({ poolId, modelId });
    }
  }

  async function hydrateSnapshots(pool, selectedModels, previousModels = []) {
    clearRemovedModelSnapshots(pool.id, previousModels, selectedModels);
    for (const modelId of selectedModels) {
      rebuildHealthyMihomoSnapshot({ pool, directory: null, modelId, nowMs: now() });
    }
  }

  async function rebuildPoolSnapshots(poolId, directory = null, selectedModels = null) {
    const pool = await getPool(poolId);
    if (!isActiveMihomoPool(pool)) {
      clearHealthyMihomoPool(poolId);
      return null;
    }
    const state = pools.get(poolId);
    const models = cloneModels(selectedModels || state?.selectedModels || await loadSelectedModels());
    for (const modelId of models) {
      rebuildHealthyMihomoSnapshot({ pool, directory, modelId, nowMs: now() });
    }
    return pool;
  }

  async function loadFreshDirectory(pool, config, client) {
    const warnings = [];
    for (const providerName of config.providerNames) {
      try {
        if (typeof client.healthCheckProvider === "function") {
          await client.healthCheckProvider(providerName);
        }
      } catch (error) {
        warnings.push(`Provider healthcheck failed for ${providerName}: ${errorMessage(error)}`);
      }
    }

    const selector = await client.getProxy(config.selectorName);
    const proxies = await client.getProxies();
    const providerDataByName = {};
    for (const providerName of config.providerNames) {
      providerDataByName[providerName] = await client.getProxyProvider(providerName);
    }
    const directory = buildMihomoNodeDirectory({
      selector,
      selectorName: config.selectorName,
      proxies,
      providerDataByName,
      providerNames: config.providerNames,
      includeRegex: config.includeRegex,
      excludeRegex: config.excludeRegex,
      mihomoState: migrateMihomoState(pool.mihomoState),
    });
    return {
      ...directory,
      warnings: [...warnings, ...(directory.warnings || [])],
    };
  }

  function currentPoolPredicate({
    poolId,
    state,
    cycleId,
    config,
    directory,
    modelId = null,
    nodeKeys = null,
    nodeVersions = null,
  }) {
    const expectedFingerprint = configFingerprint(config);
    const keys = directory ? directoryKeySet(directory) : null;
    return (current) => {
      if (!isActiveMihomoPool(current)) return false;
      if (state.cycleId !== cycleId || state.abortController?.signal.aborted) return false;
      let currentConfig;
      try {
        currentConfig = normalizeMihomoConfig(current.mihomo);
      } catch {
        return false;
      }
      if (configFingerprint(currentConfig) !== expectedFingerprint) return false;
      if (modelId && !state.selectedModels.includes(modelId)) return false;
      if (nodeKeys && keys) {
        for (const key of nodeKeys) {
          if (!keys.has(key)) return false;
        }
      }
      if (nodeVersions) {
        for (const [key, expectedVersion] of nodeVersions.entries()) {
          const separator = key.indexOf("\0");
          const node = {
            proxyProvider: key.slice(0, separator),
            nodeName: key.slice(separator + 1),
          };
          if ((keys && !keys.has(key)) || mappingVersion(current, node) !== expectedVersion) return false;
        }
      }
      return true;
    };
  }

  async function isCurrentJob({
    poolId,
    state,
    cycleId,
    config,
    directory,
    modelId = null,
    nodeKeys = null,
    nodeVersions = null,
  }) {
    const current = await getPool(poolId);
    return currentPoolPredicate({
      poolId,
      state,
      cycleId,
      config,
      directory,
      modelId,
      nodeKeys,
      nodeVersions,
    })(current);
  }

  async function enqueueAndWait(job) {
    const queued = scheduler.enqueue(job);
    if (queued?.completion && typeof queued.completion.then === "function") {
      return queued.completion;
    }
    return queued;
  }

  async function runEgressJobs({ poolId, pool, config, directory, state, cycleId }) {
    const sortedNodes = [...(directory.nodes || [])]
      .filter(validDirectoryNode)
      .map((node) => ({
        node,
        egress: getMihomoNodeEgress(pool, node),
      }))
      .sort((left, right) => (
        egressProbeRank(left.egress ? { ...left.node, egress: left.egress } : left.node, now(), config.egressProbeTtlMs)
          - egressProbeRank(right.egress ? { ...right.node, egress: right.egress } : right.node, now(), config.egressProbeTtlMs)
          || nodeKey(left.node).localeCompare(nodeKey(right.node))
      ));
    const jobs = [];
    for (const { node } of sortedNodes) {
      const expectedMappingVersion = mappingVersion(pool, node);
      const key = nodeKey(node);
      const nodeVersions = new Map([[key, expectedMappingVersion]]);
      const isCurrent = () => isCurrentJob({
        poolId,
        state,
        cycleId,
        config,
        directory,
        nodeKeys: new Set([key]),
        nodeVersions,
      });
      const guardedMutate = createGuardedMutation({
        poolId,
        mutate,
        isCurrent: currentPoolPredicate({
          poolId,
          state,
          cycleId,
          config,
          directory,
          nodeKeys: new Set([key]),
        }),
      });
      jobs.push(enqueueAndWait({
        key: getMihomoMaintenanceJobKey({
          kind: "egress",
          poolId,
          proxyProvider: node.proxyProvider,
          nodeName: node.nodeName,
        }),
        kind: "egress",
        poolId,
        proxyProvider: node.proxyProvider,
        nodeName: node.nodeName,
        cycleId,
        selectorKey: selectorKey(config),
        priority: MIHOMO_MAINTENANCE_PRIORITY.egress,
        signal: state.abortController.signal,
        isCurrent,
        run: async () => {
          const probeStartedAtMs = now();
          const result = await probeEgress({
            poolId,
            proxyProvider: node.proxyProvider,
            nodeName: node.nodeName,
            getPool,
            makeClient,
            mutatePool: guardedMutate,
            nowMs: probeStartedAtMs,
            selectorLeasePriority: MIHOMO_MAINTENANCE_PRIORITY.egress,
            signal: state.abortController.signal,
            expectedMappingVersion,
            probeStartedAtMs,
            cycleId,
          });
          await rebuildPoolSnapshots(poolId, directory, state.selectedModels);
          return {
            ok: result?.ok === true,
            stale: result?.stale === true || result?.persisted?.stale === true,
            result,
          };
        },
      }));
    }
    return Promise.all(jobs);
  }

  async function runBusinessJobs({
    poolId,
    pool,
    config,
    directory,
    groups,
    state,
    cycleId,
    selectedModels,
    modelId = null,
    identityKey = null,
  }) {
    const requestedModels = modelId ? selectedModels.filter((selectedModelId) => selectedModelId === modelId) : selectedModels;
    const requestedGroups = identityKey ? groups.filter((group) => group.identityKey === identityKey) : groups;
    const checked = new Set();
    const total = requestedModels.length * requestedGroups.length;
    await updateMaintenance(poolId, {
      status: "probing-business",
      totalBusinessChecks: total,
      completedBusinessChecks: 0,
      healthyByModel: currentHealthyCounts(pool, selectedModels, groups, now()),
    });

    while (checked.size < total) {
      if (state.abortController.signal.aborted || !sameModels(selectedModels, state.selectedModels)) return { canceled: true };
      const currentPool = await getPool(poolId);
      if (!isActiveMihomoPool(currentPool)) return { canceled: true };
      const currentGroups = buildMihomoEgressGroupEntries({ pool: currentPool, directory, nowMs: now() })
        .filter((group) => !identityKey || group.identityKey === identityKey);
      const selected = chooseBusinessCombination({
        pool: currentPool,
        models: requestedModels,
        groups: currentGroups,
        checked,
        nowMs: now(),
      });
      if (!selected) break;
      const combinationKey = `${selected.modelId}\0${selected.group.identityKey}`;
      checked.add(combinationKey);
      const usableNodes = selected.group.nodes.filter((node) => !isTransportCooling(node, now()));
      if (usableNodes.length === 0) {
        await updateMaintenance(poolId, {
          completedBusinessChecks: checked.size,
          healthyByModel: currentHealthyCounts(currentPool, selectedModels, currentGroups, now()),
        });
        continue;
      }

      const entry = { ...selected.group, nodes: usableNodes };
      const nodeVersions = new Map(usableNodes.map((node) => [nodeKey(node), node.mappingVersion]));
      const isCurrent = () => isCurrentJob({
        poolId,
        state,
        cycleId,
        config,
        directory,
        modelId: selected.modelId,
        nodeKeys: new Set(usableNodes.map(nodeKey)),
        nodeVersions,
      });
      const guardedMutate = createGuardedMutation({
        poolId,
        mutate,
        isCurrent: currentPoolPredicate({
          poolId,
          state,
          cycleId,
          config,
          directory,
          modelId: selected.modelId,
          nodeKeys: new Set(usableNodes.map(nodeKey)),
          nodeVersions,
        }),
      });
      await enqueueAndWait({
        key: getMihomoMaintenanceJobKey({
          kind: "business",
          poolId,
          modelId: selected.modelId,
          identityKey: entry.identityKey,
        }),
        kind: "business",
        poolId,
        modelId: selected.modelId,
        identityKey: entry.identityKey,
        cycleId,
        selectorKey: selectorKey(config),
        priority: MIHOMO_MAINTENANCE_PRIORITY.business,
        signal: state.abortController.signal,
        isCurrent,
        run: async () => {
          const result = await probeBusiness({
            poolId,
            modelId: selected.modelId,
            entry,
            getPool,
            mutatePool: guardedMutate,
            timeoutMs: config.businessProbeTimeoutMs,
            signal: state.abortController.signal,
            persist: true,
            cycleId,
            onHealthChanged: async () => {
              await rebuildPoolSnapshots(poolId, directory, state.selectedModels);
            },
            isCurrent,
          });
          await rebuildPoolSnapshots(poolId, directory, state.selectedModels);
          return {
            ok: result?.ok === true,
            stale: result?.stale === true,
            result,
          };
        },
      });
      const refreshed = await getPool(poolId);
      const refreshedGroups = buildMihomoEgressGroupEntries({ pool: refreshed, directory, nowMs: now() });
      await updateMaintenance(poolId, {
        completedBusinessChecks: checked.size,
        healthyByModel: currentHealthyCounts(refreshed, selectedModels, refreshedGroups, now()),
      });
    }
    return { canceled: false, completed: checked.size, total };
  }

  async function executeScopedCycle({ poolId, state, cycleId, config, selectedModels, request }) {
    let pool = await getPool(poolId);
    if (!isActiveMihomoPool(pool)) return { canceled: true };
    const completedAt = now();

    if (request.scope === "inventory") {
      await updateMaintenance(poolId, {
        cycleId,
        status: "discovering",
        startedAt: iso(completedAt),
        completedAt: null,
        nextRunAt: null,
        selectedModels,
        lastError: null,
      });
      const client = makeClient({
        controllerUrl: config.controllerUrl,
        secret: config.controllerSecret,
        timeoutMs: config.controllerTimeoutMs,
      });
      const directory = await loadFreshDirectory(pool, config, client);
      if (state.abortController.signal.aborted) return { canceled: true };
      await mutate(poolId, (current) => {
        if (!isActiveMihomoPool(current)) return current;
        current.mihomoState = persistInventoryState(current, directory);
        return current;
      });
      pool = await getPool(poolId);
      const mappedNodeCount = directory.nodes.filter((node) => isMihomoStableEgress(getMihomoNodeEgress(pool, node), now())).length;
      const groups = buildMihomoEgressGroupEntries({ pool, directory, nowMs: now() });
      await updateMaintenance(poolId, {
        status: "probing-egress",
        nodeCount: directory.nodes.length,
        mappedNodeCount,
        distinctEgressCount: groups.length,
        totalBusinessChecks: 0,
        completedBusinessChecks: 0,
        healthyByModel: currentHealthyCounts(pool, selectedModels, groups, now()),
      });
      await rebuildPoolSnapshots(poolId, directory, selectedModels);
      await runEgressJobs({ poolId, pool, config, directory, state, cycleId });
      if (state.abortController.signal.aborted) return { canceled: true };
      pool = await rebuildPoolSnapshots(poolId, directory, selectedModels);
      const finalGroups = buildMihomoEgressGroupEntries({ pool, directory, nowMs: now() });
      const finishedAt = now();
      await updateMaintenance(poolId, {
        cycleId,
        status: "complete",
        completedAt: iso(finishedAt),
        nextRunAt: iso(finishedAt + config.inventoryRefreshMs),
        selectedModels,
        nodeCount: directory.nodes.length,
        mappedNodeCount: directory.nodes.filter((node) => isMihomoStableEgress(getMihomoNodeEgress(pool, node), finishedAt)).length,
        distinctEgressCount: finalGroups.length,
        totalBusinessChecks: 0,
        completedBusinessChecks: 0,
        healthyByModel: currentHealthyCounts(pool, selectedModels, finalGroups, finishedAt),
        lastError: null,
      });
      state.nextRunAt = finishedAt + config.inventoryRefreshMs;
      return { canceled: false, completed: 0, total: 0 };
    }

    const stateSnapshot = migrateMihomoState(pool.mihomoState).maintenance;
    const groups = buildMihomoEgressGroupEntries({ pool, directory: null, nowMs: now() });
    await updateMaintenance(poolId, {
      cycleId,
      status: "probing-business",
      startedAt: iso(completedAt),
      completedAt: null,
      nextRunAt: stateSnapshot.nextRunAt || null,
      selectedModels,
      nodeCount: stateSnapshot.nodeCount,
      mappedNodeCount: stateSnapshot.mappedNodeCount,
      distinctEgressCount: groups.length,
      lastError: null,
    });
    await rebuildPoolSnapshots(poolId, null, selectedModels);
    const matrixResult = await runBusinessJobs({
      poolId,
      pool,
      config,
      directory: null,
      groups,
      state,
      cycleId,
      selectedModels,
      modelId: request.modelId,
      identityKey: request.scope === "egress" ? request.identityKey : null,
    });
    if (matrixResult.canceled || state.abortController.signal.aborted) return { canceled: true };
    pool = await rebuildPoolSnapshots(poolId, null, selectedModels);
    const finalGroups = buildMihomoEgressGroupEntries({ pool, directory: null, nowMs: now() });
    const finishedAt = now();
    const nextRunAt = finiteTime(stateSnapshot.nextRunAt) > finishedAt
      ? stateSnapshot.nextRunAt
      : iso(finishedAt + config.inventoryRefreshMs);
    await updateMaintenance(poolId, {
      cycleId,
      status: "complete",
      completedAt: iso(finishedAt),
      nextRunAt,
      selectedModels,
      nodeCount: stateSnapshot.nodeCount,
      mappedNodeCount: stateSnapshot.mappedNodeCount,
      distinctEgressCount: finalGroups.length,
      totalBusinessChecks: matrixResult.total,
      completedBusinessChecks: matrixResult.completed,
      healthyByModel: currentHealthyCounts(pool, selectedModels, finalGroups, finishedAt),
      lastError: null,
    });
    state.nextRunAt = finiteTime(nextRunAt);
    return matrixResult;
  }

  async function executeCycle(poolId, state, reason) {
    const cycleId = createCycleId();
    state.cycleId = cycleId;
    state.abortController = new AbortController();
    const canConsumeRefresh = reason.includes("manual:") || reason === "wake-rerun";
    const refreshRequest = canConsumeRefresh
      ? state.refreshRequests.shift() || { scope: "all", modelId: null, identityKey: null }
      : { scope: "all", modelId: null, identityKey: null };
    let pool = await getPool(poolId);
    if (!isActiveMihomoPool(pool)) return { canceled: true };

    let config;
    try {
      config = normalizeMihomoConfig(pool.mihomo || {});
    } catch (error) {
      await updateMaintenance(poolId, {
        cycleId,
        status: "degraded",
        startedAt: iso(now()),
        completedAt: iso(now()),
        nextRunAt: iso(now() + DEFAULT_TICK_MS),
        lastError: errorMessage(error),
      });
      return { canceled: false, error };
    }

    const selectedModels = await loadSelectedModels();
    state.selectedModels = selectedModels;
    await pruneDeletedModels(poolId, selectedModels);
    pool = await getPool(poolId);
    if (refreshRequest.scope !== "all") {
      return executeScopedCycle({ poolId, state, cycleId, config, selectedModels, request: refreshRequest });
    }
    await updateMaintenance(poolId, {
      cycleId,
      status: "discovering",
      startedAt: iso(now()),
      completedAt: null,
      nextRunAt: null,
      selectedModels,
      nodeCount: 0,
      mappedNodeCount: 0,
      distinctEgressCount: 0,
      totalBusinessChecks: 0,
      completedBusinessChecks: 0,
      healthyByModel: Object.fromEntries(selectedModels.map((modelId) => [modelId, 0])),
      lastError: null,
    });

    let directory;
    try {
      const client = makeClient({
        controllerUrl: config.controllerUrl,
        secret: config.controllerSecret,
        timeoutMs: config.controllerTimeoutMs,
      });
      directory = await loadFreshDirectory(pool, config, client);
    } catch (error) {
      if (state.abortController.signal.aborted) return { canceled: true };
      await updateMaintenance(poolId, {
        status: "degraded",
        completedAt: iso(now()),
        nextRunAt: iso(now() + config.inventoryRefreshMs),
        lastError: errorMessage(error),
      });
      return { canceled: false, error };
    }

    if (state.abortController.signal.aborted) return { canceled: true };
    await mutate(poolId, (current) => {
      if (!isActiveMihomoPool(current)) return current;
      current.mihomoState = persistInventoryState(current, directory);
      return current;
    });
    pool = await getPool(poolId);
    const stableNodeCount = directory.nodes.filter((node) => isMihomoStableEgress(getMihomoNodeEgress(pool, node), now())).length;
    const initialGroups = buildMihomoEgressGroupEntries({ pool, directory, nowMs: now() });
    await updateMaintenance(poolId, {
      status: "probing-egress",
      nodeCount: directory.nodes.length,
      mappedNodeCount: stableNodeCount,
      distinctEgressCount: initialGroups.length,
    });
    await rebuildPoolSnapshots(poolId, directory, selectedModels);

    await runEgressJobs({ poolId, pool, config, directory, state, cycleId });
    if (state.abortController.signal.aborted || !sameModels(selectedModels, state.selectedModels)) return { canceled: true };

    pool = await getPool(poolId);
    const groups = buildMihomoEgressGroupEntries({ pool, directory, nowMs: now() });
    const matrixResult = await runBusinessJobs({
      poolId,
      pool,
      config,
      directory,
      groups,
      state,
      cycleId,
      selectedModels,
    });
    if (matrixResult.canceled || state.abortController.signal.aborted) return { canceled: true };

    pool = await rebuildPoolSnapshots(poolId, directory, selectedModels);
    const completedAt = now();
    const finalGroups = buildMihomoEgressGroupEntries({ pool, directory, nowMs: completedAt });
    await updateMaintenance(poolId, {
      status: "complete",
      completedAt: iso(completedAt),
      nextRunAt: iso(completedAt + config.inventoryRefreshMs),
      selectedModels,
      nodeCount: directory.nodes.length,
      mappedNodeCount: directory.nodes.filter((node) => isMihomoStableEgress(getMihomoNodeEgress(pool, node), completedAt)).length,
      distinctEgressCount: finalGroups.length,
      totalBusinessChecks: selectedModels.length * groups.length,
      completedBusinessChecks: matrixResult.completed,
      healthyByModel: currentHealthyCounts(pool, selectedModels, finalGroups, completedAt),
      lastError: null,
    });
    state.nextRunAt = completedAt + config.inventoryRefreshMs;
    return { canceled: false, completed: matrixResult.completed };
  }

  function schedulePoolCycle(poolId, reason = "manual") {
    const state = pools.get(poolId);
    if (!state) return Promise.resolve({ canceled: true });
    state.reasons.add(reason);
    if (state.cyclePromise) {
      state.rerunRequested = true;
      return state.cyclePromise;
    }
    if (state.cycleScheduled) return state.scheduledPromise;
    state.cycleScheduled = true;
    state.scheduledPromise = Promise.resolve().then(async () => {
      state.cycleScheduled = false;
      const cycleReason = [...state.reasons].join(",") || reason;
      state.reasons.clear();
      const cyclePromise = (async () => {
        try {
          return await executeCycle(poolId, state, cycleReason);
        } catch (error) {
          if (!state.abortController?.signal.aborted) {
            await updateMaintenance(poolId, {
              status: "degraded",
              completedAt: iso(now()),
              nextRunAt: iso(now() + DEFAULT_TICK_MS),
              lastError: errorMessage(error),
            }).catch(() => {});
          }
          return { canceled: state.abortController?.signal.aborted === true, error };
        } finally {
          if (pools.get(poolId) !== state) return;
          state.abortController = null;
          state.cyclePromise = null;
          if (state.rerunRequested && started) {
            state.rerunRequested = false;
            schedulePoolCycle(poolId, "wake-rerun");
          }
        }
      })();
      state.cyclePromise = cyclePromise;
      return cyclePromise;
    });
    return state.scheduledPromise;
  }

  async function synchronizePool(pool, { selectedModels = null, scheduleCycle = false, reason = "tick" } = {}) {
    if (!started) return null;
    if (!isActiveMihomoPool(pool)) {
      remove(pool?.id);
      return null;
    }
    const poolId = pool.id;
    let state = pools.get(poolId);
    if (!state) {
      state = {
        selectedModels: [],
        cycleId: null,
        cyclePromise: null,
        scheduledPromise: null,
        cycleScheduled: false,
        rerunRequested: false,
        reasons: new Set(),
        abortController: null,
        hydrated: false,
        nextRunAt: null,
        refreshRequests: [],
      };
      pools.set(poolId, state);
    }
    if (!Array.isArray(state.refreshRequests)) state.refreshRequests = [];
    const models = cloneModels(selectedModels || await loadSelectedModels());
    const modelSetChanged = !sameModels(state.selectedModels, models);
    const firstSync = !state.hydrated;
    const previousModels = state.selectedModels;
    state.selectedModels = models;
    if (modelSetChanged || firstSync) {
      await pruneDeletedModels(poolId, models);
      const latest = await getPool(poolId);
      if (latest) await hydrateSnapshots(latest, models, previousModels);
      state.hydrated = true;
    }
    await updateMaintenance(poolId, { selectedModels: models });
    const due = !state.nextRunAt || state.nextRunAt <= now();
    if (state.cyclePromise || state.cycleScheduled) {
      if (modelSetChanged) state.rerunRequested = true;
    } else if (scheduleCycle || modelSetChanged || due) {
      schedulePoolCycle(poolId, reason);
    }
    return state;
  }

  async function synchronizePools({ initial = false, selectedModels = null, reason = "tick" } = {}) {
    const active = await getPools({ isActive: true });
    if (!started) return [];
    const activeMihomoIds = new Set();
    for (const pool of active) {
      if (!started) break;
      if (!isActiveMihomoPool(pool)) continue;
      activeMihomoIds.add(pool.id);
      await synchronizePool(pool, {
        selectedModels,
        scheduleCycle: initial,
        reason,
      });
    }
    for (const poolId of [...pools.keys()]) {
      if (!activeMihomoIds.has(poolId)) remove(poolId);
    }
    return [...activeMihomoIds];
  }

  async function tick() {
    if (!started) return;
    try {
      await synchronizePools({ reason: "tick" });
    } catch (error) {
      // A controller/database failure is recorded by the cycle that owns the
      // pool. The process-level tick must remain alive for the next attempt.
      void error;
    }
  }

  async function start() {
    if (started) return startPromise || Promise.resolve([...pools.keys()]);
    started = true;
    tickHandle = schedule(() => { void tick(); }, Math.max(1000, Number(tickMs) || DEFAULT_TICK_MS));
    if (typeof tickHandle?.unref === "function") tickHandle.unref();
    startPromise = synchronizePools({ initial: true, reason: "startup" });
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function stop() {
    started = false;
    if (tickHandle) cancelSchedule(tickHandle);
    tickHandle = null;
    for (const [poolId, state] of pools.entries()) {
      state.abortController?.abort();
      scheduler.cancelPool(poolId);
      clearHealthyMihomoPool(poolId);
    }
    pools.clear();
    scheduler.reset();
    return true;
  }

  async function wake(poolId = null, reason = "manual") {
    if (!started) await start();
    if (!started) return { accepted: false };
    if (poolId === null || poolId === undefined) {
      const models = await loadSelectedModels();
      for (const state of pools.values()) {
        if (state.cyclePromise) state.rerunRequested = true;
      }
      await synchronizePools({ selectedModels: models, reason });
      for (const [id, state] of pools.entries()) {
        if (state.cyclePromise) continue;
        schedulePoolCycle(id, reason);
      }
      return { accepted: true, poolId: null, reason };
    }
    const pool = await getPool(poolId);
    if (!isActiveMihomoPool(pool)) {
      remove(poolId);
      return { accepted: false, poolId, reason };
    }
    const models = await loadSelectedModels();
    const wasBusy = Boolean(pools.get(poolId)?.cyclePromise || pools.get(poolId)?.cycleScheduled);
    const state = await synchronizePool(pool, {
      selectedModels: models,
      scheduleCycle: true,
      reason,
    });
    if (wasBusy && (state?.cyclePromise || state?.cycleScheduled)) state.rerunRequested = true;
    return { accepted: true, poolId, reason };
  }

  async function refresh(poolId, { scope = "all", modelId = null, identityKey = null } = {}) {
    const normalizedPoolId = text(poolId);
    const normalizedScope = text(scope) || "all";
    if (!started) await start();
    const state = pools.get(normalizedPoolId);
    const request = {
      scope: normalizedScope,
      modelId: modelId || null,
      identityKey: identityKey || null,
    };
    const duplicateRequest = Boolean(state?.refreshRequests?.some((pending) => (
      pending.scope === request.scope
        && pending.modelId === request.modelId
        && pending.identityKey === request.identityKey
    )));
    const deduplicated = duplicateRequest || Boolean(state?.cyclePromise || state?.cycleScheduled);
    if (state && !duplicateRequest) state.refreshRequests.push(request);
    const result = await wake(normalizedPoolId, `manual:${normalizedScope}`);
    return {
      accepted: result.accepted === true,
      poolId: normalizedPoolId,
      reason: "manual",
      deduplicated,
      scope: normalizedScope,
      modelId: modelId || null,
      identityKey: identityKey || null,
    };
  }

  function remove(poolId) {
    const normalizedPoolId = text(poolId);
    if (!normalizedPoolId) return false;
    const state = pools.get(normalizedPoolId);
    state?.abortController?.abort();
    scheduler.cancelPool(normalizedPoolId);
    pools.delete(normalizedPoolId);
    clearHealthyMihomoPool(normalizedPoolId);
    return Boolean(state);
  }

  async function drain() {
    while (true) {
      const cycles = [...pools.values()].map((state) => state.cyclePromise || state.scheduledPromise).filter(Boolean);
      await scheduler.drain();
      if (cycles.length === 0) return scheduler.snapshot();
      await Promise.all(cycles);
      if (scheduler.snapshot().pending === 0 && scheduler.snapshot().running.length === 0
        && ![...pools.values()].some((state) => state.cyclePromise || state.cycleScheduled)) return scheduler.snapshot();
    }
  }

  function snapshot() {
    return {
      started,
      pools: [...pools.entries()].map(([poolId, state]) => ({
        poolId,
        selectedModels: [...state.selectedModels],
        cycleId: state.cycleId,
        running: Boolean(state.cyclePromise || state.cycleScheduled),
        rerunRequested: state.rerunRequested,
        nextRunAt: state.nextRunAt,
        hydrated: state.hydrated,
        pendingRefreshes: state.refreshRequests.length,
      })),
      scheduler: scheduler.snapshot(),
    };
  }

  return {
    start,
    stop,
    wake,
    refresh,
    remove,
    drain,
    snapshot,
    runPoolCycle: (poolId, reason = "manual") => schedulePoolCycle(poolId, reason),
  };
}

const defaultService = createMihomoMaintenanceService();

export function startMihomoMaintenance() {
  return defaultService.start();
}

export function stopMihomoMaintenance() {
  return defaultService.stop();
}

export function wakeMihomoMaintenance(poolId = null, reason = "manual") {
  return defaultService.wake(poolId, reason);
}

export function refreshMihomoMaintenance(poolId, options = {}) {
  return defaultService.refresh(poolId, options);
}

export function removeMihomoMaintenancePool(poolId) {
  return defaultService.remove(poolId);
}

export function drainMihomoMaintenance() {
  return defaultService.drain();
}

export function getMihomoMaintenanceServiceSnapshot() {
  return defaultService.snapshot();
}

export default defaultService;
