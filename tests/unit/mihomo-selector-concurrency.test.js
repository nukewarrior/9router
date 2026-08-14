import { describe, expect, it, vi } from "vitest";
import { withMihomoSelectorLease } from "../../src/lib/network/mihomoRouteManager.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function pool() {
  return {
    id: "pool-1",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18080",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      controllerSecret: "secret",
      selectorName: "Test Selector",
    },
  };
}

describe("Mihomo Selector lease", () => {
  it("serializes selector handoff through verify and callback", async () => {
    const events = [];
    let releaseA;
    const holdA = new Promise((resolve) => { releaseA = resolve; });
    const fakeClient = {
      selectProxy: vi.fn(async (_selector, node) => events.push(`PUT:${node}`)),
      getProxy: vi.fn(async (selector) => {
        events.push(`GET:${selector}`);
        return { type: "Selector", now: events.some((event) => event === "PUT:A") && !events.includes("PUT:B") ? "A" : "B" };
      }),
    };

    const makeClient = vi.fn(() => fakeClient);
    const getPool = vi.fn(async () => pool());
    const first = withMihomoSelectorLease({ poolId: "pool-1", nodeName: "A", getPool, makeClient }, async (proxyOptions, route) => {
      events.push("CALLBACK:A");
      expect(proxyOptions).toMatchObject({
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://router:18080",
        connectionNoProxy: "",
        strictProxy: true,
        ephemeralProxyDispatcher: true,
        mihomoManaged: true,
      });
      expect(route).not.toHaveProperty("controllerSecret");
      await holdA;
      events.push("RETURN:A");
      return "A";
    });
    await tick();
    const second = withMihomoSelectorLease({ poolId: "pool-1", nodeName: "B", getPool, makeClient }, async (_proxyOptions, route) => {
      events.push(`CALLBACK:${route.nodeName}`);
      return route.nodeName;
    });
    await tick();

    expect(events).toEqual(["PUT:A", "GET:Test Selector", "CALLBACK:A"]);
    releaseA();
    await expect(Promise.all([first, second])).resolves.toEqual(["A", "B"]);
    expect(events).toEqual([
      "PUT:A", "GET:Test Selector", "CALLBACK:A", "RETURN:A",
      "PUT:B", "GET:Test Selector", "CALLBACK:B",
    ]);
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Selector verification does not match", async () => {
    const fakeClient = {
      selectProxy: vi.fn(),
      getProxy: vi.fn().mockResolvedValue({ type: "Selector", now: "OTHER" }),
    };
    await expect(withMihomoSelectorLease({
      poolId: "pool-1",
      nodeName: "A",
      getPool: async () => pool(),
      makeClient: () => fakeClient,
    }, async () => "unreachable")).rejects.toMatchObject({ code: "MIHOMO_SELECTOR_SWITCH_FAILED" });
  });

  it("lets a queued request run before later maintenance leases", async () => {
    const events = [];
    let selectedNode = null;
    let releaseMaintenance;
    const maintenanceGate = new Promise((resolve) => { releaseMaintenance = resolve; });
    const client = {
      selectProxy: vi.fn(async (_selector, node) => {
        selectedNode = node;
        events.push(`PUT:${node}`);
      }),
      getProxy: vi.fn(async () => ({ type: "Selector", now: selectedNode })),
    };
    const options = (nodeName, priority) => ({
      poolId: "pool-1",
      nodeName,
      priority,
      getPool: async () => pool(),
      makeClient: () => client,
    });

    const first = withMihomoSelectorLease(options("A", 20), async () => {
      events.push("CALLBACK:A");
      await maintenanceGate;
    });
    await tick();
    const secondMaintenance = withMihomoSelectorLease(options("B", 20), async (_proxyOptions, route) => {
      events.push(`CALLBACK:${route.nodeName}`);
    });
    const request = withMihomoSelectorLease(options("C", 0), async (_proxyOptions, route) => {
      events.push(`CALLBACK:${route.nodeName}`);
    });

    releaseMaintenance();
    await Promise.all([first, secondMaintenance, request]);
    expect(events).toEqual([
      "PUT:A", "CALLBACK:A", "PUT:C", "CALLBACK:C", "PUT:B", "CALLBACK:B",
    ]);
  });
});
