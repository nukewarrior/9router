import { isMihomoEgressFresh } from "./mihomoState.js";
import {
  createMihomoMaintenanceScheduler,
  MIHOMO_MAINTENANCE_PRIORITY,
} from "./mihomoMaintenanceScheduler.js";

const DEFAULT_BACKOFF_MS = Object.freeze([60000, 180000, 600000, 1800000]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function getMihomoEgressProbeReason(egress, { nowMs = Date.now(), ttlMs = 21600000 } = {}) {
  if (!egress) return "unknown";
  if (egress.needsProbe === true) return "needsProbe";
  if (!isMihomoEgressFresh(egress, nowMs)) return "stale";

  const expiresAt = Number(egress.expiresAt);
  const ttl = Math.max(60000, Number(ttlMs) || 21600000);
  const refreshWindow = Math.min(1800000, ttl * 0.2);
  if (Number.isFinite(expiresAt) && expiresAt - nowMs <= refreshWindow) return "expiring";
  return null;
}

function reasonPriority(reason) {
  if (reason === "needsProbe") return 0;
  if (reason === "unknown") return 1;
  if (reason === "stale") return 2;
  if (reason === "expiring") return 3;
  return 4;
}

export function getMihomoEgressProbeKey({ poolId, proxyProvider, nodeName } = {}) {
  const normalizedPoolId = text(poolId);
  const normalizedProvider = text(proxyProvider) || "__selector__";
  const normalizedNode = text(nodeName);
  if (!normalizedPoolId || !normalizedNode) return null;
  return normalizedPoolId + "\0" + normalizedProvider + "\0" + normalizedNode;
}

async function defaultProbeNode(options) {
  const { probeMihomoNodeEgress } = await import("./mihomoEgressDiscovery.js");
  return probeMihomoNodeEgress(options);
}

export function createMihomoEgressScheduler({
  probeNode = defaultProbeNode,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  backoffMs = DEFAULT_BACKOFF_MS,
  onEvent = null,
} = {}) {
  const scheduler = createMihomoMaintenanceScheduler({
    now,
    schedule,
    cancel,
    backoffMs,
    onEvent,
    runJob: async (job) => {
      const { probeNode: jobProbeNode, ...probeOptions } = job;
      const result = await (jobProbeNode || probeNode)(probeOptions);
      if (result?.ok !== true) {
        return {
          ok: false,
          error: result?.errors?.at?.(-1) || "Egress probe returned no stable result",
          result,
        };
      }
      return { ok: true, result };
    },
  });

  function snapshot() {
    const raw = scheduler.snapshot();
    return {
      pending: raw.pending,
      running: raw.running[0] || null,
      entries: raw.entries.map((entry) => ({
        key: entry.key,
        status: entry.status,
        reason: entry.reason || null,
        lastAttemptAt: entry.lastAttemptAt,
        backoffLevel: entry.backoffLevel,
        nextAttemptAt: entry.nextAttemptAt,
        lastError: entry.lastError,
      })),
    };
  }

  function enqueue(options = {}) {
    const key = getMihomoEgressProbeKey(options);
    if (!key) return { queued: false, reason: "invalid-key", key: null };
    const nowMs = now();
    const reason = options.reason || getMihomoEgressProbeReason(options.egress, {
      nowMs,
      ttlMs: options.ttlMs,
    }) || "manual";
    const result = scheduler.enqueue({
      ...options,
      key,
      kind: "egress",
      reason,
      priority: Number.isFinite(Number(options.priority))
        ? Number(options.priority)
        : Math.max(MIHOMO_MAINTENANCE_PRIORITY.egress, reasonPriority(reason)),
      selectorKey: options.selectorKey || options.mihomoSelectorKey || "default",
    });
    return {
      ...result,
      reason: ["queued", "forced"].includes(result.reason) ? reason : result.reason,
    };
  }

  function enqueueBatch({ nodes = [], ...commonOptions } = {}) {
    const results = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      results.push(enqueue({
        ...commonOptions,
        ...node,
        reason: node.reason || getMihomoEgressProbeReason(node.egress, {
          nowMs: commonOptions.nowMs ?? now(),
          ttlMs: commonOptions.ttlMs,
        }),
      }));
    }
    return {
      queued: results.filter((result) => result.queued).length,
      skipped: results.filter((result) => !result.queued).length,
      results,
    };
  }

  return {
    enqueue,
    enqueueBatch,
    drain: scheduler.drain,
    reset: scheduler.reset,
    snapshot,
    cancelPool: scheduler.cancelPool,
  };
}

const defaultScheduler = createMihomoEgressScheduler();

export function enqueueMihomoEgressProbe(options) {
  return defaultScheduler.enqueue(options);
}

export function enqueueMihomoEgressBatch(options) {
  return defaultScheduler.enqueueBatch(options);
}

export function drainMihomoEgressScheduler() {
  return defaultScheduler.drain();
}

export function getMihomoEgressSchedulerSnapshot() {
  return defaultScheduler.snapshot();
}

export function resetMihomoEgressScheduler() {
  defaultScheduler.reset();
}
