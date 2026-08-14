import { createMihomoClient } from "./mihomoClient.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import {
  attachMihomoNodeEgress,
  discoverMihomoNodeDirectory,
  getMihomoModelHealthState,
  getMihomoNodeTransportState,
  isMihomoEgressFresh,
  isMihomoStableEgress,
  migrateMihomoState,
} from "./mihomoState.js";
import { summarizeMihomoEgressInventory } from "./mihomoEgressDiscovery.js";
import { isMihomoProxyPool } from "./proxyPoolTypes.js";
import { testProxyUrl } from "./proxyTest.js";

const DEFAULT_LISTENER_TEST_URL = "https://www.gstatic.com/generate_204";

export class MihomoAdminError extends Error {
  constructor(code, message, status = 502, details = {}) {
    super(message);
    this.name = "MihomoAdminError";
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function requireMihomoPool(pool) {
  if (!isMihomoProxyPool(pool)) {
    throw new MihomoAdminError("MIHOMO_INVALID_CONFIG", "Selected proxy pool is not a Mihomo pool", 400);
  }
  if (!text(pool.proxyUrl)) {
    throw new MihomoAdminError("MIHOMO_INVALID_CONFIG", "Mihomo proxy listener URL is required", 400);
  }
  return pool;
}

function mergedConfig(pool, override = null) {
  const base = pool?.mihomo && typeof pool.mihomo === "object" ? pool.mihomo : {};
  const incoming = override && typeof override === "object" ? override : {};
  const requestedSecret = Object.prototype.hasOwnProperty.call(incoming, "controllerSecret")
    ? text(incoming.controllerSecret)
    : "";
  return normalizeMihomoConfig({
    ...base,
    ...incoming,
    controllerSecret: requestedSecret || text(base.controllerSecret),
  });
}

function emptyModelHealthState() {
  return {
    status: "unknown",
    refreshAt: null,
    expiresAt: null,
    cooldownUntil: null,
    lastStatus: null,
    lastErrorType: null,
    lastError: null,
    lastSuccessAt: null,
  };
}

function publicNode(node, pool, modelId, allNodes = [], nowMs = Date.now()) {
  const transport = getMihomoNodeTransportState(pool, node);
  const egress = node.egress || null;
  const stableFresh = isMihomoStableEgress(egress, nowMs);
  const exitGroupSize = stableFresh
    ? allNodes.filter((candidate) => isMihomoStableEgress(candidate.egress, nowMs) && candidate.egress.identityKey === egress.identityKey).length
    : 0;
  const exitState = stableFresh && modelId
    ? getMihomoModelHealthState(pool, egress.identityKey, modelId)
    : emptyModelHealthState();
  const exitCooldownAt = exitState ? Date.parse(exitState.cooldownUntil || "") : NaN;
  const egressCooldownActive = stableFresh
    && exitState.status === "cooling"
    && Number.isFinite(exitCooldownAt)
    && exitCooldownAt > nowMs;
  const nodeCooldownAt = Date.parse(transport.cooldownUntil || "");
  const nodeCooldownActive = Number.isFinite(nodeCooldownAt) && nodeCooldownAt > nowMs;
  const egressError = Number(exitState?.lastStatus) >= 400 || Boolean(exitState?.lastErrorType || exitState?.lastError);
  const modelExpiry = Date.parse(exitState?.expiresAt || "");
  const modelActive = ["healthy", "refreshing"].includes(exitState?.status)
    && Number.isFinite(modelExpiry)
    && modelExpiry > nowMs
    && !egressCooldownActive;
  const effectiveStatus = egressCooldownActive
    ? "cooling"
    : nodeCooldownActive
      ? "degraded"
      : exitState?.status === "invalid"
        ? "invalid"
        : ["healthy", "refreshing"].includes(exitState?.status) && !modelActive
          ? "expired"
          : modelActive
            ? exitState.status
            : egressError
              ? "degraded"
              : "warming";
  const effectiveCooldownAt = egressCooldownActive
    ? exitCooldownAt
    : nodeCooldownActive
      ? nodeCooldownAt
      : NaN;
  const effectiveCooldownUntil = Number.isFinite(effectiveCooldownAt)
    ? new Date(effectiveCooldownAt).toISOString()
    : null;
  const cooldownScope = egressCooldownActive ? "model-egress" : nodeCooldownActive ? "node-transport" : null;
  const nodeCooldownUntil = Number.isFinite(nodeCooldownAt) ? new Date(nodeCooldownAt).toISOString() : null;
  const modelKey = modelId || "model";
  return {
    name: node.nodeName,
    nodeName: node.nodeName,
    proxyProvider: node.proxyProvider,
    region: node.region,
    type: node.type,
    alive: node.alive,
    delayMs: node.delayMs,
    history: node.history,
    exitIp: egress?.ip || null,
    exitIpFamily: egress?.family || null,
    exitIdentityKey: egress?.identityKey || null,
    exitConfidence: egress?.confidence || "unknown",
    exitFresh: isMihomoEgressFresh(egress, nowMs),
    exitObservedAt: egress?.observedAt || null,
    exitExpiresAt: egress?.expiresAt || null,
    exitMappingAgeMs: Number.isFinite(Number(egress?.observedAt)) ? Math.max(0, nowMs - Number(egress.observedAt)) : null,
    exitGroupSize,
    exitCooldownUntil: Number.isFinite(exitCooldownAt) ? new Date(exitCooldownAt).toISOString() : null,
    effectiveStatus,
    effectiveCooldownUntil,
    cooldownScope,
    modelId: modelId || null,
    providerState: {
      [modelKey]: {
        status: effectiveStatus,
        cooldownUntil: effectiveCooldownUntil,
        nodeCooldownUntil,
        egressCooldownUntil: Number.isFinite(exitCooldownAt) ? new Date(exitCooldownAt).toISOString() : null,
        cooldownScope,
        lastStatus: exitState.lastStatus ?? null,
        lastErrorType: exitState.lastErrorType ?? null,
        lastSuccessAt: exitState.lastSuccessAt ?? null,
      },
    },
  };
}

function clientFor(config, makeClient) {
  return makeClient({
    controllerUrl: config.controllerUrl,
    secret: config.controllerSecret,
    timeoutMs: config.controllerTimeoutMs,
  });
}

function normalizeControllerFailure(error) {
  if (error instanceof MihomoAdminError) return error;
  const code = error?.code || "MIHOMO_CONTROLLER_FAILED";
  const upstreamStatus = Number(error?.status);
  const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
    ? upstreamStatus
    : 502;
  return new MihomoAdminError(code, error?.message || "Mihomo Controller request failed", status, { cause: error });
}

/**
 * Validate the control plane, configured providers, leaf candidates and the
 * listener in one safe, non-OpenCode test. No secret is included in the
 * returned object.
 */
export async function testMihomoPool({
  pool,
  configOverride = null,
  makeClient = createMihomoClient,
  testProxy = testProxyUrl,
  testUrl = DEFAULT_LISTENER_TEST_URL,
} = {}) {
  requireMihomoPool(pool);
  let config;
  try {
    config = mergedConfig(pool, configOverride);
  } catch (error) {
    throw new MihomoAdminError("MIHOMO_INVALID_CONFIG", error.message, 400, { cause: error });
  }

  const startedAt = Date.now();
  const client = clientFor(config, makeClient);
  let version;
  let selector;
  let directory;
  try {
    version = await client.getVersion();
    selector = await client.getProxy(config.selectorName);
    directory = await discoverMihomoNodeDirectory({
      // Admin tests must not reuse a node directory cached by the request
      // router when the form contains a newly edited selector/filter.
      poolId: `${pool.id || "test"}\0admin-test\0${Date.now()}`,
      client,
      selectorName: config.selectorName,
      providerNames: config.providerNames,
      includeRegex: config.includeRegex,
      excludeRegex: config.excludeRegex,
      mihomoState: pool.mihomoState,
      ttlMs: 1000,
    });
  } catch (error) {
    throw normalizeControllerFailure(error);
  }

  if (directory.nodes.length === 0) {
    throw new MihomoAdminError(
      "MIHOMO_NO_LEAF_NODES",
      "Mihomo Selector has no eligible leaf proxy nodes",
      422,
      { directory },
    );
  }

  let listener;
  try {
    listener = await testProxy({
      proxyUrl: pool.proxyUrl,
      testUrl,
      timeoutMs: config.controllerTimeoutMs,
    });
  } catch (error) {
    throw new MihomoAdminError("MIHOMO_LISTENER_FAILED", error?.message || "Mihomo proxy listener test failed", 502, { cause: error });
  }
  if (!listener?.ok) {
    throw new MihomoAdminError(
      "MIHOMO_LISTENER_FAILED",
      listener?.error || `Mihomo proxy listener returned status ${listener?.status || "unknown"}`,
      502,
      { listener },
    );
  }

  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    controller: {
      version: version || null,
      selector: {
        name: config.selectorName,
        type: text(selector?.type) || null,
        now: text(selector?.now) || null,
      },
      providers: config.providerNames,
    },
    listener: {
      ok: true,
      status: listener.status || 200,
      statusText: listener.statusText || null,
      elapsedMs: listener.elapsedMs || 0,
    },
    nodes: directory.nodes.map((node) => ({
      name: node.nodeName,
      proxyProvider: node.proxyProvider,
      region: node.region,
      alive: node.alive,
      delayMs: node.delayMs,
    })),
    summary: summarizeMihomoEgressInventory(directory.nodes),
    warnings: directory.warnings,
  };
}

export async function getMihomoNodeStatus({
  pool,
  modelId = null,
  makeClient = createMihomoClient,
  nowMs = Date.now(),
} = {}) {
  requireMihomoPool(pool);
  let config;
  try {
    config = mergedConfig(pool);
  } catch (error) {
    throw new MihomoAdminError("MIHOMO_INVALID_CONFIG", error.message, 400, { cause: error });
  }
  const state = migrateMihomoState(pool.mihomoState);
  const selectedModelId = text(modelId) || state.maintenance.selectedModels[0] || null;
  const client = clientFor(config, makeClient);
  let selector;
  let directory;
  try {
    selector = await client.getProxy(config.selectorName);
    directory = attachMihomoNodeEgress(await discoverMihomoNodeDirectory({
      poolId: pool.id,
      client,
      selectorName: config.selectorName,
      providerNames: config.providerNames,
      includeRegex: config.includeRegex,
      excludeRegex: config.excludeRegex,
      mihomoState: pool.mihomoState,
      ttlMs: config.syncTtlMs,
      nowMs,
    }), pool);
  } catch (error) {
    throw normalizeControllerFailure(error);
  }

  return {
    selector: {
      name: config.selectorName,
      type: text(selector?.type) || null,
      now: text(selector?.now) || null,
    },
    modelId: selectedModelId,
    nodes: directory.nodes.map((node) => publicNode(node, pool, selectedModelId, directory.nodes, nowMs)),
    summary: summarizeMihomoEgressInventory(directory.nodes, nowMs),
    warnings: directory.warnings,
    fetchedAt: new Date().toISOString(),
  };
}

export function mihomoAdminErrorResponse(error) {
  const normalized = normalizeControllerFailure(error);
  return {
    status: normalized.status || 502,
    body: {
      error: normalized.message,
      code: normalized.code || "MIHOMO_ADMIN_FAILED",
    },
  };
}
