import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withMihomoSelection: vi.fn(),
  fetch: vi.fn(),
  agents: [],
  getProxyPoolById: vi.fn(),
}));

vi.mock("@/lib/network/mihomoController.js", () => ({
  withMihomoSelection: mocks.withMihomoSelection,
}));

vi.mock("undici", () => ({
  ProxyAgent: class FakeProxyAgent {
    constructor(options) {
      this.options = options;
      this.closed = false;
      mocks.agents.push(this);
    }

    close() {
      this.closed = true;
      return Promise.resolve();
    }
  },
}));

vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
}));

const originalGlobalFetch = globalThis.fetch;

function routing(poolId, nodeName = poolId) {
  return {
    poolId,
    controllerId: "controller-1",
    providerName: "airport",
    nodeName,
    selectorName: "9Router",
    sourceAvailable: true,
  };
}

function proxyOptions(mihomoRouting) {
  return {
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://127.0.0.1:7890",
    connectionNoProxy: "",
    strictProxy: true,
    mihomoRouting,
  };
}

async function loadProxyFetch() {
  globalThis.fetch = mocks.fetch;
  vi.resetModules();
  return import("../../open-sse/utils/proxyFetch.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agents.length = 0;
  mocks.fetch.mockResolvedValue(new Response("ok", { status: 200 }));
  mocks.withMihomoSelection.mockImplementation(async (_routing, operation) => operation());
  mocks.getProxyPoolById.mockReset();
});

afterAll(() => {
  globalThis.fetch = originalGlobalFetch;
});

describe("Mihomo proxy request routing", () => {
  it("resolves a managed pool into strict internal Mihomo routing metadata", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      id: "pool-a",
      name: "Node A",
      type: "mihomo",
      proxyUrl: "http://127.0.0.1:7890",
      noProxy: "",
      isActive: true,
      strictProxy: false,
      controllerId: "controller-1",
      providerName: "airport",
      nodeName: "Node A",
      selectorName: "9Router",
      sourceAvailable: true,
    });
    vi.resetModules();
    const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");

    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: "pool-a" });

    expect(resolved).toMatchObject({
      source: "mihomo",
      proxyPoolId: "pool-a",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7890",
      strictProxy: true,
      mihomoRouting: {
        poolId: "pool-a",
        controllerId: "controller-1",
        providerName: "airport",
        nodeName: "Node A",
        selectorName: "9Router",
        sourceAvailable: true,
      },
    });
  });

  it("keeps an active managed pool fail-closed when its mixed URL is missing", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      id: "pool-a",
      name: "Node A",
      type: "mihomo",
      proxyUrl: "",
      noProxy: "",
      isActive: true,
      controllerId: "controller-1",
      providerName: "airport",
      nodeName: "Node A",
      selectorName: "9Router",
      sourceAvailable: true,
    });
    vi.resetModules();
    const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");

    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: "pool-a" });

    expect(resolved).toMatchObject({
      source: "mihomo",
      connectionProxyEnabled: true,
      connectionProxyUrl: "",
      strictProxy: true,
    });
  });

  it("selects the requested node before starting the upstream fetch", async () => {
    const events = [];
    mocks.withMihomoSelection.mockImplementation(async (selectedRouting, operation) => {
      events.push(`select:${selectedRouting.nodeName}`);
      return operation();
    });
    mocks.fetch.mockImplementation(async () => {
      events.push("fetch");
      return new Response("ok", { status: 200 });
    });

    const { proxyAwareFetch } = await loadProxyFetch();
    const selected = routing("pool-a", "Node A");
    await proxyAwareFetch("http://upstream.example.test/chat", {}, proxyOptions(selected));

    expect(events).toEqual(["select:Node A", "fetch"]);
    expect(mocks.withMihomoSelection).toHaveBeenCalledWith(selected, expect.any(Function));
  });

  it("uses distinct dispatchers for pools sharing the same mixed proxy URL", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    await proxyAwareFetch(
      "http://upstream.example.test/a",
      {},
      proxyOptions(routing("pool-a", "Node A")),
    );
    await proxyAwareFetch(
      "http://upstream.example.test/b",
      {},
      proxyOptions(routing("pool-b", "Node B")),
    );

    expect(mocks.agents).toHaveLength(2);
    expect(mocks.fetch.mock.calls[0][1].dispatcher).not.toBe(
      mocks.fetch.mock.calls[1][1].dispatcher,
    );
  });

  it("reuses a pool-specific dispatcher and evicts the least recently used Agent", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();

    await proxyAwareFetch("http://upstream.example.test/first", {}, proxyOptions(routing("pool-0")));
    const firstDispatcher = mocks.fetch.mock.calls[0][1].dispatcher;
    await proxyAwareFetch("http://upstream.example.test/reuse", {}, proxyOptions(routing("pool-0")));
    expect(mocks.fetch.mock.calls[1][1].dispatcher).toBe(firstDispatcher);

    for (let index = 1; index <= 20; index += 1) {
      await proxyAwareFetch(
        `http://upstream.example.test/${index}`,
        {},
        proxyOptions(routing(`pool-${index}`)),
      );
    }

    expect(mocks.agents).toHaveLength(21);
    expect(firstDispatcher.closed).toBe(true);
  });

  it("fails closed when Controller selection fails", async () => {
    mocks.withMihomoSelection.mockRejectedValue(new Error("selector unavailable"));
    const { proxyAwareFetch } = await loadProxyFetch();

    await expect(proxyAwareFetch(
      "http://upstream.example.test/chat",
      {},
      proxyOptions(routing("pool-a")),
    )).rejects.toThrow("Proxy required but failed");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed without consulting the Controller when the mirrored source is unavailable", async () => {
    const { proxyAwareFetch } = await loadProxyFetch();
    const unavailable = { ...routing("pool-a"), sourceAvailable: false };

    await expect(proxyAwareFetch(
      "http://upstream.example.test/chat",
      {},
      proxyOptions(unavailable),
    )).rejects.toThrow("direct fallback is disabled");
    expect(mocks.withMihomoSelection).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not retry directly after the mixed proxy connection fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { proxyAwareFetch } = await loadProxyFetch();

    await expect(proxyAwareFetch(
      "http://upstream.example.test/chat",
      {},
      proxyOptions(routing("pool-a")),
    )).rejects.toThrow("Proxy required but failed");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
