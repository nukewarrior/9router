import { describe, expect, it } from "vitest";
import {
  createMihomoMaintenanceScheduler,
  getMihomoMaintenanceJobKey,
} from "../../src/lib/network/mihomoMaintenanceScheduler.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Mihomo maintenance scheduler", () => {
  it("serializes work per Selector while allowing different Selectors to run", async () => {
    const events = [];
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const scheduler = createMihomoMaintenanceScheduler({
      runJob: async (job) => {
        events.push("start:" + job.nodeName);
        if (job.nodeName === "A") await gateA;
        events.push("end:" + job.nodeName);
        return { ok: true };
      },
    });

    scheduler.enqueue({ kind: "egress", poolId: "p", nodeName: "A", selectorKey: "selector-a" });
    scheduler.enqueue({ kind: "egress", poolId: "p", nodeName: "B", selectorKey: "selector-a" });
    scheduler.enqueue({ kind: "egress", poolId: "p", nodeName: "C", selectorKey: "selector-b" });
    await tick();

    expect(events).toEqual(["start:A", "start:C", "end:C"]);
    releaseA();
    await scheduler.drain();
    expect(events).toEqual(["start:A", "start:C", "end:C", "end:A", "start:B", "end:B"]);
  });

  it("deduplicates running jobs and prioritizes manual work", async () => {
    const events = [];
    let releaseRunning;
    const runningGate = new Promise((resolve) => { releaseRunning = resolve; });
    const scheduler = createMihomoMaintenanceScheduler({
      runJob: async (job) => {
        events.push("start:" + job.nodeName);
        if (job.nodeName === "running") await runningGate;
        events.push("end:" + job.nodeName);
        return { ok: true };
      },
    });

    expect(scheduler.enqueue({ kind: "egress", poolId: "p", nodeName: "running", selectorKey: "s" }).queued).toBe(true);
    await tick();
    expect(scheduler.enqueue({ kind: "egress", poolId: "p", nodeName: "running", selectorKey: "s" }))
      .toMatchObject({ queued: false, reason: "duplicate" });
    scheduler.enqueue({ kind: "business", poolId: "p", modelId: "m", identityKey: "e2", selectorKey: "s" });
    scheduler.enqueue({ kind: "manual", manual: true, poolId: "p", identityKey: "e1", selectorKey: "s" });

    releaseRunning();
    await scheduler.drain();
    expect(events).toEqual(["start:running", "end:running", "start:undefined", "end:undefined", "start:undefined", "end:undefined"]);
    expect(scheduler.snapshot().pending).toBe(0);
  });

  it("backs off failures, allows force refresh, and discards stale jobs without backoff", async () => {
    let attempts = 0;
    let nowMs = 0;
    const scheduler = createMihomoMaintenanceScheduler({
      now: () => nowMs,
      backoffMs: [1000],
      runJob: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: "temporary" } : { ok: true };
      },
    });
    const job = { kind: "business", poolId: "p", modelId: "m", identityKey: "e1" };
    scheduler.enqueue(job);
    await scheduler.drain();
    expect(scheduler.snapshot().entries[0]).toMatchObject({ backoffLevel: 1, nextAttemptAt: 1000 });
    expect(scheduler.enqueue(job)).toMatchObject({ queued: false, reason: "backoff" });
    expect(scheduler.enqueue({ ...job, force: true })).toMatchObject({ queued: true, reason: "forced" });
    await scheduler.drain();
    expect(attempts).toBe(2);

    const staleScheduler = createMihomoMaintenanceScheduler({
      runJob: async () => ({ ok: false, stale: true }),
    });
    staleScheduler.enqueue({ kind: "egress", poolId: "p", nodeName: "stale" });
    await staleScheduler.drain();
    expect(staleScheduler.snapshot().entries[0]).toMatchObject({ stale: true, backoffLevel: 0, nextAttemptAt: 0 });
  });

  it("builds stable job keys from pool/model/egress/node identity", () => {
    expect(getMihomoMaintenanceJobKey({
      kind: "business",
      poolId: "p",
      modelId: "m",
      identityKey: "4:198.51.100.20",
      proxyProvider: "sub",
      nodeName: "Node A",
    })).toBe(["business", "p", "m", "4:198.51.100.20", "sub", "Node A"].join("\0"));
  });
});
