import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

const {
  getMihomoVersion,
  selectMihomoNode,
  withMihomoSelection,
  MihomoControllerError,
} = await import("@/lib/network/mihomoController.js");

const config = {
  id: "controller-1",
  enabled: true,
  controllerUrl: "http://127.0.0.1:9090/",
  secret: "server-secret",
  proxyUrl: "http://127.0.0.1:7890",
  selectorName: "group/primary",
  providerNames: ["airport"],
  syncIntervalMinutes: 5,
};

function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__mihomoSelectionMutexes = new Map();
  mocks.getSettings.mockResolvedValue({ mihomoController: config });
});

describe("Mihomo Controller client", () => {
  it("uses direct undici fetch with Bearer authentication", async () => {
    mocks.fetch.mockResolvedValue(response({ version: "1.19.0" }));

    await expect(getMihomoVersion(config)).resolves.toEqual({ version: "1.19.0" });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9090/version",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer server-secret" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("omits Bearer authentication when the secret is empty", async () => {
    mocks.fetch.mockResolvedValue(response({ version: "1.19.0" }));

    await getMihomoVersion({ ...config, secret: "" });

    expect(mocks.fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });

  it("normalizes timeout and malformed Controller responses", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocks.fetch.mockRejectedValueOnce(timeout);
    await expect(getMihomoVersion(config)).rejects.toMatchObject({ code: "MIHOMO_TIMEOUT" });

    mocks.fetch.mockResolvedValueOnce(response({ version: "" }));
    await expect(getMihomoVersion(config)).rejects.toMatchObject({ code: "MIHOMO_INVALID_RESPONSE" });
  });

  it("encodes the Selector path and sends the required PUT body", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({
        proxies: { "group/primary": { type: "Selector", all: ["node/one", "node-two"] } },
      }))
      .mockResolvedValueOnce(response(null));

    await selectMihomoNode(config, "group/primary", "node/one");

    expect(mocks.fetch.mock.calls[1][0]).toBe("http://127.0.0.1:9090/proxies/group%2Fprimary");
    expect(mocks.fetch.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ name: "node/one" }),
      headers: expect.objectContaining({ Authorization: "Bearer server-secret" }),
    });
  });

  it("rejects a node that is no longer in Selector.all without a PUT", async () => {
    mocks.fetch.mockResolvedValue(response({
      proxies: { primary: { type: "Selector", all: ["other-node"] } },
    }));

    await expect(selectMihomoNode(config, "primary", "node-one"))
      .rejects.toMatchObject({ code: "MIHOMO_NODE_NOT_SELECTABLE" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes selection and operation under controller plus selector", async () => {
    const events = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options.method === "PUT") return response(null);
      return response({ proxies: { primary: { type: "Selector", all: ["node-a", "node-b"] } } });
    });

    const first = withMihomoSelection(
      { poolId: "pool-a", controllerId: "controller-1", providerName: "p", nodeName: "node-a", selectorName: "primary" },
      async () => {
        events.push("first-start");
        await firstGate;
        events.push("first-end");
        return "first-response";
      },
    );
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    const second = withMihomoSelection(
      { poolId: "pool-b", controllerId: "controller-1", providerName: "p", nodeName: "node-b", selectorName: "primary" },
      async () => {
        events.push("second");
        return "second-response";
      },
    );

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first-response");
    await expect(second).resolves.toBe("second-response");
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("returns structured safe errors for invalid schemes and does not expose secrets", async () => {
    await expect(getMihomoVersion({ ...config, controllerUrl: "file:///tmp/controller", secret: "hidden" }))
      .rejects.toMatchObject({ code: "MIHOMO_INVALID_CONFIG" });

    mocks.fetch.mockResolvedValue(response({ error: "server-secret" }, 401));
    const error = await getMihomoVersion(config).catch((value) => value);
    expect(error).toBeInstanceOf(MihomoControllerError);
    expect(error.message).not.toContain("server-secret");
    expect(error.message).not.toContain(config.controllerUrl);
  });
});
