import { isMihomoEgressFresh } from "./mihomoState.js";

const DEFAULT_BACKOFF_MS = Object.freeze([60000, 180000, 600000, 1800000]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function formatError(error) {
  return text(error?.message || error) || "Mihomo egress probe failed";
}

/**
 * Return the reason a node should be refreshed, or null when its mapping is
 * currently fresh enough. This deliberately excludes dynamic/tentative
 * mappings: they are diagnosis information and must not be promoted to a
 * stable identity merely because a request happened to pass through them.
 */
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
  return `${normalizedPoolId}\0${normalizedProvider}\0${normalizedNode}`;
}

async function defaultProbeNode(options) {
  // Keep discovery's Selector-lease dependency out of this module's import
  // graph. The dynamic import also leaves the scheduler cheap to load during
  // application bootstrap and easy to replace in unit tests.
  const { probeMihomoNodeEgress } = await import("./mihomoEgressDiscovery.js");
  return probeMihomoNodeEgress(options);
}

/**
 * Create a serial, process-local egress probe queue. A single queue instance
 * owns one Selector control plane, so it intentionally never probes two nodes
 * concurrently. Timer and clock injection keep the behavior deterministic in
 * unit tests without adding a database or an external worker.
 */
export function createMihomoEgressScheduler({
  probeNode = defaultProbeNode,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  backoffMs = DEFAULT_BACKOFF_MS,
} = {}) {
  const entries = new Map();
  const pending = [];
  const normalizedBackoff = Array.isArray(backoffMs) && backoffMs.length > 0
    ? backoffMs.map((value) => Math.max(1, Number(value) || 1))
    : [...DEFAULT_BACKOFF_MS];
  let running = null;
  let wakeTimer = null;
  let immediateScheduled = false;
  let waiters = [];

  function snapshotEntry(entry) {
    return {
      key: entry.key,
      status: entry.status,
      reason: entry.reason,
      lastAttemptAt: entry.lastAttemptAt,
      backoffLevel: entry.backoffLevel,
      nextAttemptAt: entry.nextAttemptAt,
      lastError: entry.lastError,
    };
  }

  function snapshot() {
    return {
      pending: pending.filter((key) => entries.get(key)?.status === "pending").length,
      running: running?.key || null,
      entries: [...entries.values()].map(snapshotEntry),
    };
  }

  function resolveIdleWaiters() {
    if (running || pending.some((key) => entries.get(key)?.status === "pending")) return;
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve(snapshot());
  }

  function clearWakeTimer() {
    if (wakeTimer === null) return;
    cancel(wakeTimer);
    wakeTimer = null;
  }

  function scheduleProcess(delayMs = 0) {
    if (delayMs <= 0) {
      clearWakeTimer();
      if (immediateScheduled) return;
      immediateScheduled = true;
      Promise.resolve().then(() => {
        immediateScheduled = false;
        void processQueue();
      });
      return;
    }
    if (wakeTimer !== null) return;
    wakeTimer = schedule(() => {
      wakeTimer = null;
      void processQueue();
    }, delayMs);
    if (typeof wakeTimer?.unref === "function") wakeTimer.unref();
  }

  function scheduleNextPending() {
    const nowMs = now();
    const nextAt = pending
      .map((key) => entries.get(key))
      .filter((entry) => entry?.status === "pending")
      .reduce((earliest, entry) => Math.min(earliest, entry.nextAttemptAt || nowMs), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextAt)) scheduleProcess(Math.max(0, nextAt - nowMs));
    else resolveIdleWaiters();
  }

  function choosePendingEntry() {
    const nowMs = now();
    let selected = null;
    for (const key of pending) {
      const entry = entries.get(key);
      if (!entry || entry.status !== "pending") continue;
      if (entry.nextAttemptAt > nowMs) continue;
      if (!selected
        || entry.priority < selected.priority
        || (entry.priority === selected.priority && entry.enqueuedAt < selected.enqueuedAt)) {
        selected = entry;
      }
    }
    if (!selected) return null;
    const index = pending.indexOf(selected.key);
    if (index >= 0) pending.splice(index, 1);
    return selected;
  }

  async function processQueue() {
    if (running) return;
    const entry = choosePendingEntry();
    if (!entry) {
      scheduleNextPending();
      return;
    }

    running = entry;
    entry.status = "running";
    entry.lastAttemptAt = now();
    let result = null;
    let failure = null;
    try {
      const { probeNode: jobProbeNode, ...probeOptions } = entry.job;
      result = await (jobProbeNode || probeNode)(probeOptions);
      if (result?.ok !== true) failure = new Error(result?.errors?.at?.(-1) || "Egress probe returned no stable result");
    } catch (error) {
      failure = error;
    }

    const current = entries.get(entry.key);
    if (current === entry) {
      const finishedAt = now();
      if (failure) {
        entry.backoffLevel = Math.min(entry.backoffLevel + 1, normalizedBackoff.length);
        const delay = normalizedBackoff[Math.min(entry.backoffLevel - 1, normalizedBackoff.length - 1)];
        entry.nextAttemptAt = finishedAt + delay;
        entry.lastError = formatError(failure);
      } else {
        entry.backoffLevel = 0;
        entry.nextAttemptAt = 0;
        entry.lastError = null;
      }
      entry.status = "idle";
    }
    running = null;
    resolveIdleWaiters();
    if (pending.some((key) => entries.get(key)?.status === "pending")) scheduleProcess(0);
  }

  function enqueue(options = {}) {
    const key = getMihomoEgressProbeKey(options);
    if (!key) return { queued: false, reason: "invalid-key", key: null };
    const nowMs = now();
    const existing = entries.get(key);
    if (existing?.status === "pending" || existing?.status === "running") {
      return { queued: false, reason: "duplicate", key, status: existing.status };
    }
    if (existing && existing.nextAttemptAt > nowMs) {
      return { queued: false, reason: "backoff", key, nextAttemptAt: existing.nextAttemptAt };
    }

    const reason = options.reason || getMihomoEgressProbeReason(options.egress, {
      nowMs,
      ttlMs: options.ttlMs,
    }) || "manual";
    const entry = existing || {
      key,
      status: "idle",
      lastAttemptAt: null,
      backoffLevel: 0,
      nextAttemptAt: 0,
      lastError: null,
    };
    entry.job = { ...options, poolId: text(options.poolId), proxyProvider: text(options.proxyProvider) || "__selector__", nodeName: text(options.nodeName) };
    entry.reason = reason;
    entry.priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : reasonPriority(reason);
    entry.enqueuedAt = nowMs;
    entry.status = "pending";
    entries.set(key, entry);
    pending.push(key);
    scheduleProcess(0);
    return { queued: true, reason, key };
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

  function drain() {
    if (!running && !pending.some((key) => entries.get(key)?.status === "pending")) return Promise.resolve(snapshot());
    return new Promise((resolve) => waiters.push(resolve));
  }

  function reset() {
    clearWakeTimer();
    pending.length = 0;
    entries.clear();
    resolveIdleWaiters();
  }

  return {
    enqueue,
    enqueueBatch,
    drain,
    reset,
    snapshot,
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
