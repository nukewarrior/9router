import { describe, expect, it, vi } from "vitest";
import {
  buildMihomoBusinessProbeRequest,
  classifyMihomoBusinessProbeFailure,
  probeMihomoBusinessEgress,
} from "../../src/lib/network/mihomoBusinessProbe.js";

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || headers[name] || "";
      },
    },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function entry() {
  return {
    identityKey: "4:198.51.100.20",
    expiresAt: 9999999999999,
    evidenceVersion: 4,
    nodes: [
      {
        key: "subscription\0Primary",
        proxyProvider: "subscription",
        nodeName: "Primary",
        mappingVersion: 2,
        alive: true,
      },
      {
        key: "subscription\0Backup",
        proxyProvider: "subscription",
        nodeName: "Backup",
        mappingVersion: 2,
        alive: true,
      },
    ],
  };
}

function pool() {
  return {
    id: "probe-pool",
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:18080",
    mihomo: {
      controllerUrl: "http://192.0.2.10:9090",
      selectorName: "selector",
      businessHealthRefreshMs: 60000,
      businessHealthTtlMs: 120000,
    },
    mihomoState: {
      version: 2,
      proxyProviders: {},
      egressIdentities: {},
      maintenance: {},
    },
  };
}

describe("Mihomo OpenCode business probe", () => {
  it("builds the fixed request through the OpenCode Executor", () => {
    const request = buildMihomoBusinessProbeRequest({ modelId: "opencode/model-a" });
    expect(request.url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(request.body).toEqual({
      model: "opencode/model-a",
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      stream: false,
    });
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "x-opencode-client": "desktop",
    });
  });

  it("validates response structure and keeps probe side effects out of chat usage", async () => {
    const lease = vi.fn(async (_options, callback) => callback({ strictProxy: true }));
    const fetchRequest = vi.fn(async (_url, options, proxyOptions) => {
      expect(JSON.parse(options.body)).toMatchObject({ max_tokens: 1, stream: false });
      expect(proxyOptions).toMatchObject({
        strictProxy: true,
        ephemeralProxyDispatcher: true,
        connectionNoProxy: "",
        mihomoManaged: true,
      });
      return response({ choices: [{ message: { content: "OK" } }] });
    });

    const result = await probeMihomoBusinessEgress({
      poolId: "probe-pool",
      modelId: "opencode/model-a",
      entry: entry(),
      lease,
      fetchRequest,
      persist: false,
      nowMs: 1000,
    });

    expect(result).toMatchObject({
      ok: true,
      category: "success",
      identityKey: "4:198.51.100.20",
      route: { nodeName: "Primary", mappingVersion: 2 },
    });
    expect(lease).toHaveBeenCalledWith(expect.objectContaining({ priority: 30 }), expect.any(Function));
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("uses same-IP backup for transport failure but never for a 429", async () => {
    const transportFetch = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: "OK" } }] }));
    const transportResult = await probeMihomoBusinessEgress({
      poolId: "probe-pool",
      modelId: "opencode/model-a",
      entry: entry(),
      lease: async (_options, callback) => callback({}),
      fetchRequest: transportFetch,
      persist: false,
      nowMs: 1000,
    });
    expect(transportResult).toMatchObject({ ok: true, backupRetried: true, route: { nodeName: "Backup" } });
    expect(transportFetch).toHaveBeenCalledTimes(2);

    const rateLimitFetch = vi.fn().mockResolvedValue(response(
      { error: { message: "FreeUsageLimitError" } },
      429,
      { "retry-after": "2" },
    ));
    const rateLimitResult = await probeMihomoBusinessEgress({
      poolId: "probe-pool",
      modelId: "opencode/model-a",
      entry: entry(),
      lease: async (_options, callback) => callback({}),
      fetchRequest: rateLimitFetch,
      persist: false,
      nowMs: 1000,
    });
    expect(rateLimitResult).toMatchObject({
      ok: false,
      category: "rate_limit",
      route: { nodeName: "Primary" },
      resetsAtMs: 3000,
    });
    expect(rateLimitFetch).toHaveBeenCalledTimes(1);
  });

  it("classifies invalid model, auth, provider, and malformed responses", () => {
    expect(classifyMihomoBusinessProbeFailure({ status: 400, body: { error: { message: "unknown model" } } }))
      .toMatchObject({ category: "invalid_model" });
    expect(classifyMihomoBusinessProbeFailure({ status: 403, error: "denied" }))
      .toMatchObject({ category: "configuration" });
    expect(classifyMihomoBusinessProbeFailure({ status: 503, error: "upstream unavailable" }))
      .toMatchObject({ category: "provider_failure" });
    expect(classifyMihomoBusinessProbeFailure({ status: 200, error: "empty body" }))
      .toMatchObject({ category: "invalid_response" });
  });
});
