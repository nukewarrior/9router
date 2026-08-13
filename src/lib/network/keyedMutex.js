/**
 * A small FIFO mutex keyed by an arbitrary string. Different Mihomo
 * controllers/selectors can progress concurrently; requests sharing one
 * Selector are serialized during the selector handoff and initial fetch.
 */
export class KeyedMutex {
  constructor() {
    this.queues = new Map();
  }

  async runExclusive(key, task) {
    const mutexKey = String(key || "");
    if (!mutexKey) throw new TypeError("mutex key is required");
    if (typeof task !== "function") throw new TypeError("mutex task must be a function");

    let entry = this.queues.get(mutexKey);
    if (!entry) {
      entry = { tail: Promise.resolve(), waiters: 0 };
      this.queues.set(mutexKey, entry);
    }

    const previous = entry.tail;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    entry.tail = previous.then(() => gate);
    entry.waiters += 1;

    await previous;
    try {
      return await task();
    } finally {
      release();
      entry.waiters -= 1;
      if (entry.waiters === 0 && this.queues.get(mutexKey) === entry) {
        this.queues.delete(mutexKey);
      }
    }
  }

  get size() {
    return this.queues.size;
  }
}

export const mihomoSelectorMutex = new KeyedMutex();
