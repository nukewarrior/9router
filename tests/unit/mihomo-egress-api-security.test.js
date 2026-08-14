import { describe, expect, it } from "vitest";
import { toPublicMihomoEgressProbeResponse } from "../../src/lib/network/mihomoEgressDiscovery.js";

const INTERNAL_POOL = {
  proxyUrl: "http://test-user:test-pass@198.51.100.10:18080",
  mihomo: { controllerSecret: "test-controller-secret" },
  mihomoState: { proxyProviders: { subscription: { nodes: {} } } },
};

function probeResult() {
  return {
    ok: true,
    route: {
      proxyPoolId: "pool-1",
      proxyProvider: "subscription",
      nodeName: "Example Taiwan Node A",
      selectorName: "selector",
    },
    egress: {
      ip: "198.51.100.20",
      family: 4,
      identityKey: "4:198.51.100.20",
      confidence: "stable",
      observedIps: ["198.51.100.20"],
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 1000,
      expiresAt: 61000,
      needsProbe: false,
    },
    samples: ["198.51.100.20", "198.51.100.20"],
    errors: [],
    pool: INTERNAL_POOL,
  };
}

describe("Mihomo egress probe public response", () => {
  it("does not serialize secrets, listener credentials, or internal state for one node", () => {
    const response = toPublicMihomoEgressProbeResponse(probeResult());
    const serialized = JSON.stringify(response);

    expect(response).not.toHaveProperty("pool");
    expect(serialized).not.toContain("test-controller-secret");
    expect(serialized).not.toContain("test-user:test-pass");
    expect(serialized).not.toContain("controllerSecret");
    expect(serialized).not.toContain("mihomoState");
    expect(response).toMatchObject({ ok: true, route: { nodeName: "Example Taiwan Node A" }, egress: { identityKey: "4:198.51.100.20" } });
  });

  it("removes internal pool data from every item in a batch response", () => {
    const response = toPublicMihomoEgressProbeResponse({
      ok: true,
      requested: 1,
      results: [probeResult()],
      directory: {
        selectorName: "selector",
        nodes: [{ nodeName: "Example Taiwan Node A", proxyProvider: "subscription", egress: probeResult().egress }],
      },
      summary: { leafNodes: 1, freshStableMappings: 1 },
      pool: INTERNAL_POOL,
    });
    const serialized = JSON.stringify(response);

    expect(response).not.toHaveProperty("pool");
    expect(response.results[0]).not.toHaveProperty("pool");
    expect(serialized).not.toContain("test-controller-secret");
    expect(serialized).not.toContain("test-user:test-pass");
    expect(serialized).not.toContain("mihomoState");
  });
});
