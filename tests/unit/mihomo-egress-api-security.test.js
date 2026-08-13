import { describe, expect, it } from "vitest";
import { toPublicMihomoEgressProbeResponse } from "../../src/lib/network/mihomoEgressDiscovery.js";

const INTERNAL_POOL = {
  proxyUrl: "http://nikki:secret@10.11.11.1:17891",
  mihomo: { controllerSecret: "mihomo-controller-secret" },
  mihomoState: { proxyProviders: { subscription: { nodes: {} } } },
};

function probeResult() {
  return {
    ok: true,
    route: {
      proxyPoolId: "pool-1",
      proxyProvider: "subscription",
      nodeName: "TW-A10",
      selectorName: "selector",
    },
    egress: {
      ip: "61.219.114.43",
      family: 4,
      identityKey: "4:61.219.114.43",
      confidence: "stable",
      observedIps: ["61.219.114.43"],
      sampleCount: 2,
      successfulSamples: 2,
      observedAt: 1000,
      expiresAt: 61000,
      needsProbe: false,
    },
    samples: ["61.219.114.43", "61.219.114.43"],
    errors: [],
    pool: INTERNAL_POOL,
  };
}

describe("Mihomo egress probe public response", () => {
  it("does not serialize secrets, listener credentials, or internal state for one node", () => {
    const response = toPublicMihomoEgressProbeResponse(probeResult());
    const serialized = JSON.stringify(response);

    expect(response).not.toHaveProperty("pool");
    expect(serialized).not.toContain("mihomo-controller-secret");
    expect(serialized).not.toContain("nikki:secret");
    expect(serialized).not.toContain("controllerSecret");
    expect(serialized).not.toContain("mihomoState");
    expect(response).toMatchObject({ ok: true, route: { nodeName: "TW-A10" }, egress: { identityKey: "4:61.219.114.43" } });
  });

  it("removes internal pool data from every item in a batch response", () => {
    const response = toPublicMihomoEgressProbeResponse({
      ok: true,
      requested: 1,
      results: [probeResult()],
      directory: {
        selectorName: "selector",
        nodes: [{ nodeName: "TW-A10", proxyProvider: "subscription", egress: probeResult().egress }],
      },
      summary: { leafNodes: 1, freshStableMappings: 1 },
      pool: INTERNAL_POOL,
    });
    const serialized = JSON.stringify(response);

    expect(response).not.toHaveProperty("pool");
    expect(response.results[0]).not.toHaveProperty("pool");
    expect(serialized).not.toContain("mihomo-controller-secret");
    expect(serialized).not.toContain("nikki:secret");
    expect(serialized).not.toContain("mihomoState");
  });
});
