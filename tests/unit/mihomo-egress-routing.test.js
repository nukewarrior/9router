import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMihomoRotationState,
  getMihomoEgressCandidateKey,
  groupMihomoNodesByEgress,
  prepareMihomoRouteAttempt,
} from "../../src/lib/network/mihomoRouteManager.js";
import { clearMihomoNodeDirectoryCache } from "../../src/lib/network/mihomoState.js";

function makePool(id = "egress-route") {
  return {
    id,
    type: "mihomo",
    isActive: true,
    proxyUrl: "http://router:17892",
    mihomo: {
      controllerUrl: "http://10.11.11.1:9090",
      selectorName: "selector",
      providerNames: ["sub-a", "sub-b"],
      preferDistinctEgress: true,
      egressScopedCooldown: false,
      maxAttemptsPerRequest: 6,
      regionOrder: ["TW", "JP", "US", "SG", "HK", "OTHER"],
    },
    mihomoState: { proxyProviders: {}, egressIdentities: {} },
  };
}

function makeClient(nodes, providers = {}) {
  const proxies = Object.fromEntries(nodes.map((node) => [node.name, { type: "VLESS", alive: true }]));
  return {
    getProxy: async () => ({ type: "Selector", now: nodes[0]?.name || null, all: nodes.map((node) => node.name) }),
    getProxies: async () => ({ proxies }),
    getProxyProvider: async (providerName) => ({
      name: providerName,
      type: "HTTP",
      proxies: (providers[providerName] || []).map((name) => ({ name, type: "VLESS" })),
    }),
  };
}

function setEgress(pool, provider, nodeName, identityKey, { confidence = "stable", expiresAt = 9999999999999 } = {}) {
  const [, ip] = identityKey.split(":");
  const family = identityKey.startsWith("6:") ? 6 : 4;
  pool.mihomoState.proxyProviders[provider] ||= { nodes: {} };
  pool.mihomoState.proxyProviders[provider].nodes[nodeName] = {
    egress: {
      ip,
      family,
      identityKey,
      confidence,
      sampleCount: confidence === "unknown" ? 0 : 2,
      successfulSamples: confidence === "unknown" ? 0 : 2,
      observedAt: 100,
      expiresAt,
      lastProbeAt: 100,
      lastProbeError: null,
    },
  };
}

async function prepare(pool, nodes, context = {}) {
  return prepareMihomoRouteAttempt({
    poolId: pool.id,
    businessProviderId: "opencode",
    routeContext: {
      attemptedNodeKeys: new Set(),
      attemptedEgressKeys: new Set(),
      deprioritizedRegions: new Set(),
      attempts: 0,
      ...context,
    },
    getPool: async () => pool,
    makeClient: () => makeClient(nodes, {
      "sub-a": nodes.filter((node) => node.provider === "sub-a").map((node) => node.name),
      "sub-b": nodes.filter((node) => node.provider === "sub-b").map((node) => node.name),
    }),
    nowMs: 1000,
  });
}

beforeEach(() => {
  clearMihomoRotationState();
  clearMihomoNodeDirectoryCache();
});

describe("Mihomo egress-aware scheduling", () => {
  it("groups same-IP nodes, including nodes from different providers", () => {
    const nodes = [
      { key: "sub-a\0TW-A", nodeName: "TW-A", proxyProvider: "sub-a", region: "TW", egress: { ip: "1.2.3.4", family: 4, confidence: "stable", identityKey: "4:1.2.3.4", expiresAt: 9999 } },
      { key: "sub-b\0TW-B", nodeName: "TW-B", proxyProvider: "sub-b", region: "TW", egress: { ip: "1.2.3.4", family: 4, confidence: "stable", identityKey: "4:1.2.3.4", expiresAt: 9999 } },
      { key: "sub-a\0TW-C", nodeName: "TW-C", proxyProvider: "sub-a", region: "TW", egress: { ip: "1.2.3.5", family: 4, confidence: "stable", identityKey: "4:1.2.3.5", expiresAt: 9999 } },
    ];
    const groups = groupMihomoNodesByEgress(nodes, 1000);
    expect(groups.get("4:1.2.3.4").map((node) => node.nodeName)).toEqual(["TW-A", "TW-B"]);
    expect(groups.size).toBe(2);
  });

  it("round-robins distinct fresh stable exit identities before sibling nodes", async () => {
    const pool = makePool();
    const nodes = [
      { name: "TW-A01", provider: "sub-a" },
      { name: "TW-A02", provider: "sub-a" },
      { name: "TW-A03", provider: "sub-a" },
    ];
    setEgress(pool, "sub-a", "TW-A01", "4:1.2.3.4");
    setEgress(pool, "sub-a", "TW-A02", "4:1.2.3.4");
    setEgress(pool, "sub-a", "TW-A03", "4:1.2.3.5");
    const context = { attemptedNodeKeys: new Set(), attemptedEgressKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const options = {
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: context,
      getPool: async () => pool,
      makeClient: () => makeClient(nodes, { "sub-a": nodes.map((node) => node.name), "sub-b": [] }),
      nowMs: 1000,
    };

    const first = await prepareMihomoRouteAttempt(options);
    const second = await prepareMihomoRouteAttempt(options);
    expect(first.route.egressIdentityKey).toBe("4:1.2.3.4");
    expect(second.route.egressIdentityKey).toBe("4:1.2.3.5");
    expect(second.route.nodeName).toBe("TW-A03");
    expect(context.attemptedEgressKeys).toEqual(new Set(["4:1.2.3.4", "4:1.2.3.5"]));
  });

  it("bounds request attempts by distinct egress identities, not sibling node count", async () => {
    const pool = makePool("egress-attempt-limit");
    const nodes = [
      { name: "TW-A01", provider: "sub-a" },
      { name: "TW-A02", provider: "sub-a" },
      { name: "TW-A03", provider: "sub-a" },
    ];
    setEgress(pool, "sub-a", "TW-A01", "4:1.2.3.4");
    setEgress(pool, "sub-a", "TW-A02", "4:1.2.3.4");
    setEgress(pool, "sub-a", "TW-A03", "4:1.2.3.5");
    const context = { attemptedNodeKeys: new Set(), attemptedEgressKeys: new Set(), deprioritizedRegions: new Set(), attempts: 0 };
    const options = {
      poolId: pool.id,
      businessProviderId: "opencode",
      routeContext: context,
      getPool: async () => pool,
      makeClient: () => makeClient(nodes, { "sub-a": nodes.map((node) => node.name), "sub-b": [] }),
      nowMs: 1000,
    };

    const first = await prepareMihomoRouteAttempt(options);
    const second = await prepareMihomoRouteAttempt(options);
    const third = await prepareMihomoRouteAttempt(options);
    expect(first.route).not.toBeNull();
    expect(second.route).not.toBeNull();
    expect(context.maxAttempts).toBe(2);
    expect(third.route).toBeNull();
  });

  it("preserves region priority and skips an attempted egress key", async () => {
    const pool = makePool();
    const nodes = [
      { name: "TW-A01", provider: "sub-a" },
      { name: "TW-A02", provider: "sub-a" },
      { name: "JP-A01", provider: "sub-a" },
    ];
    setEgress(pool, "sub-a", "TW-A01", "4:1.2.3.4");
    setEgress(pool, "sub-a", "TW-A02", "4:1.2.3.5");
    setEgress(pool, "sub-a", "JP-A01", "4:9.9.9.9");
    const result = await prepare(pool, nodes, { attemptedEgressKeys: new Set(["4:1.2.3.4"]) });
    expect(result.route).toMatchObject({ region: "TW", nodeName: "TW-A02", egressIdentityKey: "4:1.2.3.5" });
  });

  it("keeps unknown, dynamic and stale mappings as independent safe candidates", async () => {
    const pool = makePool();
    const nodes = [
      { name: "TW-UNKNOWN", provider: "sub-a" },
      { name: "TW-DYNAMIC", provider: "sub-a" },
      { name: "TW-STALE", provider: "sub-a" },
    ];
    setEgress(pool, "sub-a", "TW-DYNAMIC", "4:1.2.3.4", { confidence: "dynamic" });
    setEgress(pool, "sub-a", "TW-STALE", "4:1.2.3.5", { expiresAt: 999 });
    const result = await prepare(pool, nodes);
    expect(result.route).not.toBeNull();
    expect(result.route.egressIdentityKey).toMatch(/^node:/);
    expect(getMihomoEgressCandidateKey({ key: "sub-a\0TW-UNKNOWN", egress: null }, 1000)).toBe("node:sub-a\0TW-UNKNOWN");
  });
});
