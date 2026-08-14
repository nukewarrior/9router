function abortError(message = "Mutex waiter was aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * A process-local keyed lease with priority ordering.
 *
 * A running task is never preempted. Priority only selects the next waiter;
 * equal priorities retain enqueue order.
 */
export class KeyedMutex {
  constructor() {
    this.queues = new Map();
    this.sequence = 0;
  }

  runExclusive(key, task, { priority = 0, signal = null } = {}) {
    const mutexKey = String(key || "");
    if (!mutexKey) throw new TypeError("mutex key is required");
    if (typeof task !== "function") throw new TypeError("mutex task must be a function");

    let entry = this.queues.get(mutexKey);
    if (!entry) {
      entry = { running: false, waiters: [] };
      this.queues.set(mutexKey, entry);
    }

    const normalizedPriority = Number.isFinite(Number(priority)) ? Number(priority) : 0;
    const waiter = {
      task,
      priority: normalizedPriority,
      sequence: this.sequence++,
      signal,
      onAbort: null,
      settled: false,
      resolve: null,
      reject: null,
    };

    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });

    waiter.onAbort = () => {
      if (waiter.settled) return;
      const index = entry.waiters.indexOf(waiter);
      if (index < 0) return;
      entry.waiters.splice(index, 1);
      waiter.settled = true;
      waiter.reject(abortError());
      this.drain(mutexKey, entry);
    };

    if (signal?.aborted) {
      waiter.settled = true;
      waiter.reject(abortError());
      this.cleanup(mutexKey, entry);
      return promise;
    }

    signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
    entry.waiters.push(waiter);
    this.drain(mutexKey, entry);
    return promise;
  }

  drain(key, entry) {
    if (entry.running) return;
    if (entry.waiters.length === 0) {
      this.cleanup(key, entry);
      return;
    }

    let selectedIndex = 0;
    for (let index = 1; index < entry.waiters.length; index += 1) {
      const candidate = entry.waiters[index];
      const selected = entry.waiters[selectedIndex];
      if (candidate.priority < selected.priority
        || (candidate.priority === selected.priority && candidate.sequence < selected.sequence)) {
        selectedIndex = index;
      }
    }

    const waiter = entry.waiters.splice(selectedIndex, 1)[0];
    if (waiter.settled) {
      this.drain(key, entry);
      return;
    }
    if (waiter.signal?.aborted) {
      waiter.settled = true;
      waiter.reject(abortError());
      this.drain(key, entry);
      return;
    }

    waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
    entry.running = true;
    Promise.resolve()
      .then(() => waiter.task())
      .then((value) => {
        entry.running = false;
        this.drain(key, entry);
        waiter.settled = true;
        waiter.resolve(value);
      }, (error) => {
        entry.running = false;
        this.drain(key, entry);
        waiter.settled = true;
        waiter.reject(error);
      });
  }

  cleanup(key, entry) {
    if (!entry.running && entry.waiters.length === 0 && this.queues.get(key) === entry) {
      this.queues.delete(key);
    }
  }

  get size() {
    return this.queues.size;
  }
}

export const mihomoSelectorMutex = new KeyedMutex();
