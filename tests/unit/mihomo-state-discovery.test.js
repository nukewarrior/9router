import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMihomoNodeDirectory,
  clearMihomoNodeDirectoryCache,
  classifyNodeRegion,
  discoverMihomoNodeDirectory,
  SELECTOR_PROXY_PROVIDER,
} from "../../src/lib/network/mihomoState.js";

describe("Mihomo node discovery", () => {
  beforeEach(() => clearMihomoNodeDirectoryCache());

  it("classifies supported regions without broad single-character matches", () => {
    expect(classifyNodeRegion("🇹🇼 Taiwan TW-A30")).toBe("TW");
    expect(classifyNodeRegion("日本 JP-A01")).toBe("JP");
    expect(classifyNodeRegion("United States US-B01")).toBe("US");
    expect(classifyNodeRegion("Singapore SG-A01")).toBe("SG");
    expect(classifyNodeRegion("香港 HK-A01")).toBe("HK");
    expect(classifyNodeRegion("韩国 KR-A01")).toBe("KR");
    expect(classifyNodeRegion("台服专线")).toBe("OTHER");
  });

  it("intersects provider nodes, excludes nested groups/dead nodes, and keeps warnings", () => {
    const directory = buildMihomoNodeDirectory({
      selectorName: "selector",
      selector: {
        type: "Selector",
        now: "TW-A30",
        all: ["TW-A30", "JP-A01", "auto", "dead"],
      },
      proxies: {
        "TW-A30": { type: "VLESS", alive: true, history: [{ delay: 82 }] },
        "JP-A01": { type: "HTTP", alive: true, delay: 110 },
        auto: { type: "URLTest", alive: true },
        dead: { type: "Shadowsocks", alive: false },
      },
      providerNames: ["subscription"],
      providerDataByName: {
        subscription: { proxies: [{ name: "TW-A30" }, { name: "JP-A01" }, { name: "auto" }, { name: "not-in-selector" }] },
      },
      includeRegex: "(?i)TW|JP|auto",
      excludeRegex: "A01$",
    });

    expect(directory.selectorName).toBe("selector");
    expect(directory.selectorNow).toBe("TW-A30");
    expect(directory.nodes).toHaveLength(1);
    expect(directory.nodes[0]).toMatchObject({
      key: "subscription\0TW-A30",
      nodeName: "TW-A30",
      proxyProvider: "subscription",
      region: "TW",
      delayMs: 82,
      alive: true,
    });
    expect(directory.warnings).toContain('Excluded nested proxy group "auto": type=URLTest');
  });

  it("allows unknown alive status and uses a selector provider when provider filters are absent", () => {
    const directory = buildMihomoNodeDirectory({
      selector: { type: "Selector", all: ["Custom Node"] },
      proxies: { "Custom Node": { type: "Trojan" } },
    });
    expect(directory.nodes[0]).toMatchObject({ proxyProvider: SELECTOR_PROXY_PROVIDER, alive: null, region: "OTHER" });
  });

  it("caches a directory by pool until its TTL expires", async () => {
    const client = {
      getProxy: vi.fn().mockResolvedValue({ type: "Selector", now: "A", all: ["A"] }),
      getProxies: vi.fn().mockResolvedValue({ A: { type: "VLESS", alive: true } }),
      getProxyProvider: vi.fn(),
    };

    const first = await discoverMihomoNodeDirectory({ poolId: "pool", client, selectorName: "selector", ttlMs: 1000, nowMs: 100 });
    const second = await discoverMihomoNodeDirectory({ poolId: "pool", client, selectorName: "selector", ttlMs: 1000, nowMs: 500 });
    const third = await discoverMihomoNodeDirectory({ poolId: "pool", client, selectorName: "selector", ttlMs: 1000, nowMs: 1100 });

    expect(first.nodes).toEqual(second.nodes);
    expect(client.getProxy).toHaveBeenCalledTimes(2);
    expect(client.getProxies).toHaveBeenCalledTimes(2);
    expect(third.selectorNow).toBe("A");
  });

  it("fails configuration when the configured proxy is not a Selector", () => {
    expect(() => buildMihomoNodeDirectory({ selector: { type: "URLTest", all: ["A"] } })).toThrow(/Selector/);
  });
});
