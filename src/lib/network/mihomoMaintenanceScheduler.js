export const MIHOMO_MAINTENANCE_PRIORITY = Object.freeze({
  manual: 10,
  egress: 20,
  business: 30,
});

export const DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS = Object.freeze([
  60000,
  180000,
  600000,
  1800000,
]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeBackoff(values) {
  return Array.isArray(values) && values.length > 0
    ? values.map((value) => Math.max(1, Number(value) || 1))
    : [...DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS];
}

export function getMihomoMaintenanceJobKey({
  kind = "job",
  poolId,
  modelId = "",
  identityKey = "",
  proxyProvider = "",
  nodeName = "",
} = {}) {
  const normalizedPoolId = text(poolId);
  if (!normalizedPoolId) return null;
  return [
    text(kind) || "job",
    normalizedPoolId,
    text(modelId),
    text(identityKey),
    text(proxyProvider),
    text(nodeName),
  ].join("\0");
}

function priorityForJob(job) {
  if (Number.isFinite(Number(job?.priority))) return Number(job.priority);
  if (job?.manual === true || job?.kind === "manual") return MIHOMO_MAINTENANCE_PRIORITY.manual;
  if (job?.kind === "business") return MIHOMO_MAINTENANCE_PRIORITY.business;
  return MIHOMO_MAINTENANCE_PRIORITY.egress;
}

function formatError(error) {
  return text(error?.message || error) || "Mihomo maintenance job failed";
}

function laneIsIdle(lane) {
  return !lane.running && lane.pending.length === 0;
}

export function createMihomoMaintenanceScheduler({
  runJob = async (job) => (typeof job.run === "function" ? job.run() : { ok: true }),
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  backoffMs = DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS,
  onEvent = null,
} = {}) {
  const entries = new Map();
  const lanes = new Map();
  const timers = new Map();
  const idleWaiters = [];
  const normalizedBackoff = normalizeBackoff(backoffMs);
  let sequence = 0;
  let microtaskScheduled = new Set();

  function emit(event, entry, extra = {}) {
    try {
      onEvent?.(event, {
        key: entry?.key || null,
        poolId: entry?.job?.poolId || null,
        modelId: entry?.job?.modelId || null,
        identityKey: entry?.job?.identityKey || null,
        node: entry?.job?.nodeName || null,
        cycleId: entry?.job?.cycleId || null,
        ...extra,
      });
    } catch {
      // Debug callbacks must not break maintenance.
    }
  }

  function getLane(selectorKey) {
    const normalized = text(selectorKey) || "default";
    let lane = lanes.get(normalized);
    if (!lane) {
      lane = { key: normalized, running: null, pending: [] };
      lanes.set(normalized, lane);
    }
    return lane;
  }

  function clearTimer(laneKey) {
    const timer = timers.get(laneKey);
    if (timer === undefined) return;
    cancel(timer);
    timers.delete(laneKey);
  }

  function cleanupLane(lane) {
    if (!laneIsIdle(lane)) return;
    clearTimer(lane.key);
    if (lanes.get(lane.key) === lane) lanes.delete(lane.key);
  }

  function pendingEntries(lane) {
    return lane.pending
      .map((key) => entries.get(key))
      .filter((entry) => entry?.status === "pending");
  }

  function scheduleLane(lane, delayMs = 0) {
    if (delayMs <= 0) {
      clearTimer(lane.key);
      if (microtaskScheduled.has(lane.key)) return;
      microtaskScheduled.add(lane.key);
      Promise.resolve().then(() => {
        microtaskScheduled.delete(lane.key);
        void processLane(lane);
      });
      return;
    }
    if (timers.has(lane.key)) return;
    const timer = schedule(() => {
      timers.delete(lane.key);
      void processLane(lane);
    }, delayMs);
    timers.set(lane.key, timer);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function selectPending(lane) {
    const nowMs = now();
    let selected = null;
    for (const key of lane.pending) {
      const entry = entries.get(key);
      if (!entry || entry.status !== "pending" || entry.nextAttemptAt > nowMs) continue;
      if (!selected
        || entry.priority < selected.priority
        || (entry.priority === selected.priority && entry.enqueuedAt < selected.enqueuedAt)) {
        selected = entry;
      }
    }
    if (!selected) return null;
    const index = lane.pending.indexOf(selected.key);
    if (index >= 0) lane.pending.splice(index, 1);
    return selected;
  }

  function scheduleNext(lane) {
    const nowMs = now();
    const nextAt = pendingEntries(lane)
      .reduce((earliest, entry) => Math.min(earliest, entry.nextAttemptAt || nowMs), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextAt)) scheduleLane(lane, Math.max(0, nextAt - nowMs));
    else {
      cleanupLane(lane);
      resolveIdle();
    }
  }

  function isIdle() {
    return [...lanes.values()].every(laneIsIdle);
  }

  function resolveIdle() {
    if (!isIdle()) return;
    const current = idleWaiters.splice(0);
    const value = snapshot();
    for (const resolve of current) resolve(value);
  }

  async function processLane(lane) {
    if (lane.running) return;
    const entry = selectPending(lane);
    if (!entry) {
      scheduleNext(lane);
      return;
    }
    lane.running = entry;
    entry.status = "running";
    entry.lastAttemptAt = now();
    emit("maintenance.job.start", entry);

    let result = null;
    let failure = null;
    try {
      if (typeof entry.job.isCurrent === "function" && !(await entry.job.isCurrent(entry.job))) {
        result = { ok: false, stale: true, reason: "stale_job_discarded" };
      } else {
        result = await runJob(entry.job, entry);
      }
    } catch (error) {
      failure = error;
    }

    const current = entries.get(entry.key);
    if (current === entry) {
      const finishedAt = now();
      entry.lastResult = result || null;
      entry.stale = result?.stale === true;
      if (entry.stale) {
        entry.status = "idle";
        entry.nextAttemptAt = 0;
        entry.lastError = null;
        emit("maintenance.job.stale_discarded", entry, { reason: result?.reason || "stale_job_discarded" });
      } else if (failure || result?.ok === false) {
        entry.backoffLevel = Math.min(entry.backoffLevel + 1, normalizedBackoff.length);
        const delay = normalizedBackoff[Math.min(entry.backoffLevel - 1, normalizedBackoff.length - 1)];
        entry.nextAttemptAt = finishedAt + delay;
        entry.lastError = formatError(failure || result?.error);
        entry.status = "idle";
        emit("maintenance.job.failure", entry, { error: entry.lastError });
      } else {
        entry.backoffLevel = 0;
        entry.nextAttemptAt = 0;
        entry.lastError = null;
        entry.status = "idle";
        emit("maintenance.job.success", entry);
      }
    }
    lane.running = null;
    scheduleNext(lane);
    if (pendingEntries(lane).length > 0) scheduleLane(lane, 0);
    resolveIdle();
  }

  function enqueue(job = {}) {
    const key = job.key || getMihomoMaintenanceJobKey(job);
    if (!key) return { queued: false, reason: "invalid-key", key: null };
    const nowMs = now();
    const existing = entries.get(key);
    if (existing?.status === "pending" || existing?.status === "running") {
      return { queued: false, reason: "duplicate", key, status: existing.status };
    }
    if (existing && existing.nextAttemptAt > nowMs && job.force !== true) {
      return { queued: false, reason: "backoff", key, nextAttemptAt: existing.nextAttemptAt };
    }

    const entry = existing || {
      key,
      status: "idle",
      backoffLevel: 0,
      nextAttemptAt: 0,
      lastAttemptAt: null,
      lastError: null,
      lastResult: null,
      stale: false,
    };
    entry.job = { ...job, key };
    entry.priority = priorityForJob(entry.job);
    entry.enqueuedAt = sequence++;
    entry.nextAttemptAt = job.force === true ? 0 : Math.min(entry.nextAttemptAt || 0, nowMs);
    entry.status = "pending";
    entry.stale = false;
    entries.set(key, entry);
    const lane = getLane(job.selectorKey);
    lane.pending.push(key);
    emit("maintenance.job.queued", entry);
    scheduleLane(lane, 0);
    return {
      queued: true,
      reason: job.force === true ? "forced" : "queued",
      key,
      priority: entry.priority,
      selectorKey: lane.key,
    };
  }

  function cancelJob(key) {
    const entry = entries.get(key);
    if (!entry || entry.status === "running") return false;
    const lane = lanes.get(entry.job?.selectorKey || "default");
    if (lane) {
      lane.pending = lane.pending.filter((pendingKey) => pendingKey !== key);
      cleanupLane(lane);
    }
    entries.delete(key);
    resolveIdle();
    return true;
  }

  function cancelPool(poolId) {
    let count = 0;
    for (const [key, entry] of [...entries.entries()]) {
      if (entry.status !== "running" && entry.job?.poolId === poolId && cancelJob(key)) count += 1;
    }
    return count;
  }

  function reset() {
    for (const timer of timers.values()) cancel(timer);
    timers.clear();
    microtaskScheduled = new Set();
    entries.clear();
    for (const lane of lanes.values()) lane.pending.length = 0;
    lanes.clear();
    resolveIdle();
  }

  function snapshot() {
    return {
      pending: [...entries.values()].filter((entry) => entry.status === "pending").length,
      running: [...entries.values()].filter((entry) => entry.status === "running").map((entry) => entry.key),
      entries: [...entries.values()].map((entry) => ({
        key: entry.key,
        status: entry.status,
        priority: entry.priority,
        selectorKey: entry.job?.selectorKey || "default",
        kind: entry.job?.kind || null,
        poolId: entry.job?.poolId || null,
        modelId: entry.job?.modelId || null,
        identityKey: entry.job?.identityKey || null,
        nodeName: entry.job?.nodeName || null,
        cycleId: entry.job?.cycleId || null,
        backoffLevel: entry.backoffLevel,
        nextAttemptAt: entry.nextAttemptAt,
        lastAttemptAt: entry.lastAttemptAt,
        lastError: entry.lastError,
        stale: entry.stale,
      })),
    };
  }

  function drain() {
    if (isIdle()) return Promise.resolve(snapshot());
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    enqueue,
    cancelJob,
    cancelPool,
    reset,
    drain,
    snapshot,
  };
}

const defaultScheduler = createMihomoMaintenanceScheduler();

export function enqueueMihomoMaintenanceJob(job) {
  return defaultScheduler.enqueue(job);
}

export function cancelMihomoMaintenancePool(poolId) {
  return defaultScheduler.cancelPool(poolId);
}

export function drainMihomoMaintenanceScheduler() {
  return defaultScheduler.drain();
}

export function getMihomoMaintenanceSchedulerSnapshot() {
  return defaultScheduler.snapshot();
}

export function resetMihomoMaintenanceScheduler() {
  defaultScheduler.reset();
}
