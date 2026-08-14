import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const agents = [];
const fetchMock = vi.fn();

vi.mock("undici", () => ({
  ProxyAgent: class MockProxyAgent {
    constructor(options) {
      this.options = options;
      this.close = vi.fn().mockResolvedValue(undefined);
      agents.push(this);
    }
  },
}));

describe("proxyAwareFetch managed dispatcher", () => {
  let originalFetch;
  let proxyAwareFetch;

  beforeEach(async () => {
    agents.length = 0;
    fetchMock.mockReset();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    vi.resetModules();
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a fresh ProxyAgent for every managed fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const options = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://router:18080",
      strictProxy: true,
      ephemeralProxyDispatcher: true,
    };

    await proxyAwareFetch("https://example.com/one", {}, options);
    await proxyAwareFetch("https://example.com/two", {}, options);

    expect(agents).toHaveLength(2);
    expect(agents[0]).not.toBe(agents[1]);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(agents[0]);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(agents[1]);
    expect(agents[0].close).toHaveBeenCalledOnce();
    expect(agents[1].close).toHaveBeenCalledOnce();
  });

  it("does not wait for graceful close before returning streaming headers", async () => {
    let resolveClose;
    const closePromise = new Promise((resolve) => { resolveClose = resolve; });
    fetchMock.mockImplementation(async () => {
      agents[0].close = vi.fn(() => closePromise);
      return { ok: true, status: 200, body: "stream" };
    });

    const response = await proxyAwareFetch("https://example.com/stream", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://router:18080",
      strictProxy: true,
      ephemeralProxyDispatcher: true,
    });

    expect(response.body).toBe("stream");
    expect(agents[0].close).toHaveBeenCalledOnce();
    resolveClose();
  });

  it("fails closed when a strict proxy has no usable route", async () => {
    await expect(proxyAwareFetch("https://example.com", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "",
      strictProxy: true,
    })).rejects.toThrow(/no proxy URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when strict no_proxy would bypass the managed listener", async () => {
    await expect(proxyAwareFetch("https://example.com", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://router:18080",
      connectionNoProxy: "example.com",
      strictProxy: true,
    })).rejects.toThrow(/no_proxy/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the original transport error as the strict proxy cause", async () => {
    const transportError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
    fetchMock.mockRejectedValue(transportError);

    const thrown = await proxyAwareFetch("https://example.com", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://router:18080",
      strictProxy: true,
      mihomoManaged: true,
      ephemeralProxyDispatcher: true,
    }).catch((error) => error);

    expect(thrown.cause).toBe(transportError);
    expect(thrown.cause.cause.code).toBe("UND_ERR_CONNECT_TIMEOUT");
  });
});
