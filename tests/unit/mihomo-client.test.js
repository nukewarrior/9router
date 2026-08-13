import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMihomoClient,
  MIHOMO_ERROR_CODES,
  MihomoClientError,
  validateMihomoControllerUrl,
} from "../../src/lib/network/mihomoClient.js";

const fetchMock = vi.fn();

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Mihomo Controller URL validation", () => {
  it("allows router private and loopback addresses", () => {
    expect(validateMihomoControllerUrl("http://10.11.11.1:9090")).toBe("http://10.11.11.1:9090");
    expect(validateMihomoControllerUrl("http://127.0.0.1:9090")).toBe("http://127.0.0.1:9090");
    expect(validateMihomoControllerUrl("https://router.example.test/api/")).toBe("https://router.example.test/api");
  });

  it("rejects non-web schemes, embedded credentials, query strings and metadata targets", () => {
    for (const value of [
      "file:///etc/passwd",
      "ftp://10.0.0.1:9090",
      "http://user:pass@10.0.0.1:9090",
      "http://10.0.0.1:9090/?secret=1",
      "http://10.0.0.1:9090/#fragment",
      "http://169.254.169.254/latest",
      "http://224.0.0.1:9090",
      "http://0.0.0.0:9090",
      "http://metadata.google.internal",
    ]) {
      expect(() => validateMihomoControllerUrl(value)).toThrow();
    }
  });
});

describe("Mihomo Controller client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses Bearer auth, redirect error, timeout signal and encoded path segments", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ now: "JP-A01", type: "Selector" }));
    const client = createMihomoClient({
      controllerUrl: "http://10.11.11.1:9090",
      secret: "controller-secret",
      timeoutMs: 1200,
    });

    await client.getProxy("🤖 OpenCode调度/primary");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://10.11.11.1:9090/proxies/%F0%9F%A4%96%20OpenCode%E8%B0%83%E5%BA%A6%2Fprimary");
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer controller-secret",
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends selector PUT without assuming success body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createMihomoClient({ controllerUrl: "http://127.0.0.1:9090" });

    await expect(client.selectProxy("selector", "JP-A01")).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ name: "JP-A01" }),
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("maps controller auth and invalid JSON failures to stable error codes", async () => {
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 401 }));
    const client = createMihomoClient({ controllerUrl: "http://127.0.0.1:9090", secret: "secret" });
    await expect(client.getVersion()).rejects.toMatchObject({
      code: MIHOMO_ERROR_CODES.UNAUTHORIZED,
      status: 401,
    });

    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(client.getVersion()).rejects.toMatchObject({ code: MIHOMO_ERROR_CODES.INVALID_RESPONSE });
  });

  it("maps fetch abort and network errors separately", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const client = createMihomoClient({ controllerUrl: "http://127.0.0.1:9090" });
    await expect(client.getVersion()).rejects.toMatchObject({ code: MIHOMO_ERROR_CODES.TIMEOUT });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(client.getVersion()).rejects.toMatchObject({ code: MIHOMO_ERROR_CODES.UNREACHABLE });
  });

  it("does not expose the secret on the public client object", () => {
    const client = createMihomoClient({ controllerUrl: "http://127.0.0.1:9090", secret: "secret" });
    expect(JSON.stringify(client)).not.toContain("secret");
    expect(client).not.toHaveProperty("secret");
    expect(new MihomoClientError("CODE", "message")).toBeInstanceOf(Error);
  });
});
