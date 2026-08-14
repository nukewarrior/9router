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
    expect(classifyNodeRegion("🇹🇼 Taiwan Example Taiwan Node A")).toBe("TW");
    expect(classifyNodeRegion("日本 Example Japan Node A")).toBe("JP");
    expect(classifyNodeRegion("United States Example United States Node A")).toBe("US");
    expect(classifyNodeRegion("Singapore Example Singapore Node A")).toBe("SG");
    expect(classifyNodeRegion("香港 Example Hong Kong Node A")).toBe("HK");
    expect(classifyNodeRegion("韩国 Example Korea Node A")).toBe("KR");
    expect(classifyNodeRegion("台服专线")).toBe("OTHER");
  });

  it("intersects provider nodes, excludes nested groups/dead nodes, and keeps warnings", () => {
    const directory = buildMihomoNodeDirectory({
      selectorName: "selector",
      selector: {
        type: "Selector",
        now: "Example Taiwan Node A",
        all: ["Example Taiwan Node A", "Example Japan Node A", "auto", "dead"],
      },
      proxies: {
        proxies: {
          "Example Taiwan Node A": { type: "VLESS", alive: true, history: [{ delay: 82 }] },
          "Example Japan Node A": { type: "Trojan", alive: true, history: [{ delay: 110 }] },
          auto: { type: "URLTest", alive: true },
          dead: { type: "Shadowsocks", alive: false },
        },
      },
      providerNames: ["subscription"],
      providerDataByName: {
        subscription: { proxies: [{ name: "Example Taiwan Node A" }, { name: "Example Japan Node A" }, { name: "auto" }, { name: "not-in-selector" }] },
      },
      includeRegex: "(?i)Taiwan|Japan|auto",
      excludeRegex: "never-match",
    });

    expect(directory.selectorName).toBe("selector");
    expect(directory.selectorNow).toBe("Example Taiwan Node A");
    expect(directory.nodes).toHaveLength(2);
    expect(directory.nodes[0]).toMatchObject({
      key: "subscription\0Example Taiwan Node A",
      nodeName: "Example Taiwan Node A",
      proxyProvider: "subscription",
      region: "TW",
      delayMs: 82,
      alive: true,
    });
    expect(directory.nodes[1]).toMatchObject({
      nodeName: "Example Japan Node A",
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
