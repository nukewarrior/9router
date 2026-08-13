import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMihomoNodeDirectory,
  clearMihomoNodeDirectoryCache,
  classifyNodeRegion,
  discoverMihomoNodeDirectory,
  getMihomoNodeDirectoryCacheSize,
  MIHOMO_NODE_DIRECTORY_CACHE_MAX_ENTRIES,
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
        proxies: {
          "TW-A30": { type: "VLESS", alive: true, history: [{ delay: 82 }] },
          "JP-A01": { type: "Trojan", alive: true, history: [{ delay: 110 }] },
          auto: { type: "URLTest", alive: true },
          dead: { type: "Shadowsocks", alive: false },
        },
      },
      providerNames: ["subscription"],
      providerDataByName: {
        subscription: { proxies: [{ name: "TW-A30" }, { name: "JP-A01" }, { name: "auto" }, { name: "not-in-selector" }] },
      },
      includeRegex: "(?i)TW|JP|auto",
      excludeRegex: "never-match",
    });

    expect(directory.selectorName).toBe("selector");
    expect(directory.selectorNow).toBe("TW-A30");
    expect(directory.nodes).toHaveLength(2);
    expect(directory.nodes[0]).toMatchObject({
      key: "subscription\0TW-A30",
      nodeName: "TW-A30",
      proxyProvider: "subscription",
      region: "TW",
      delayMs: 82,
      alive: true,
    });
    expect(directory.nodes[1]).toMatchObject({
      nodeName: "JP-A01",
      proxyProvider: "subscription",
      region: "JP",
      delayMs: 110,
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
      getProxies: vi.fn().mockResolvedValue({ proxies: { A: { type: "VLESS", alive: true } } }),
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

  it("cleans expired entries and caps process-local directory cache growth", async () => {
    const client = {
      getProxy: vi.fn().mockResolvedValue({ type: "Selector", now: "A", all: ["A"] }),
      getProxies: vi.fn().mockResolvedValue({ proxies: { A: { type: "VLESS", alive: true } } }),
      getProxyProvider: vi.fn(),
    };

    await discoverMihomoNodeDirectory({ poolId: "expired", client, selectorName: "selector", ttlMs: 1000, nowMs: 0 });
    await discoverMihomoNodeDirectory({ poolId: "expired-refresh", client, selectorName: "selector", ttlMs: 1000, nowMs: 2000 });
    expect(getMihomoNodeDirectoryCacheSize()).toBe(1);

    for (let index = 0; index < MIHOMO_NODE_DIRECTORY_CACHE_MAX_ENTRIES + 5; index += 1) {
      await discoverMihomoNodeDirectory({ poolId: `pool-${index}`, client, selectorName: "selector", ttlMs: 1000, nowMs: 3000 });
    }
    expect(getMihomoNodeDirectoryCacheSize()).toBe(MIHOMO_NODE_DIRECTORY_CACHE_MAX_ENTRIES);
  });
});
