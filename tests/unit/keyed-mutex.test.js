import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../../src/lib/network/keyedMutex.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("KeyedMutex", () => {
  it("serializes the same key and allows different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const events = [];
    let releaseA;
    const holdA = new Promise((resolve) => { releaseA = resolve; });

    const first = mutex.runExclusive("same", async () => {
      events.push("A:start");
      await holdA;
      events.push("A:end");
      return "A";
    });
    await tick();

    const second = mutex.runExclusive("same", async () => {
      events.push("B:start");
      events.push("B:end");
      return "B";
    });
    const different = mutex.runExclusive("other", async () => {
      events.push("C:start");
      events.push("C:end");
      return "C";
    });
    await tick();

    expect(events).toEqual(["A:start", "C:start", "C:end"]);
    releaseA();
    await expect(Promise.all([first, second, different])).resolves.toEqual(["A", "B", "C"]);
    expect(events).toEqual(["A:start", "C:start", "C:end", "A:end", "B:start", "B:end"]);
    expect(mutex.size).toBe(0);
  });

  it("releases the key after a rejected task", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive("key", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(mutex.runExclusive("key", async () => "ok")).resolves.toBe("ok");
    expect(mutex.size).toBe(0);
  });
});
