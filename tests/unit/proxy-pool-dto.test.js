import { describe, expect, it } from "vitest";
import { toPublicProxyPool, toPublicProxyPools } from "../../src/lib/network/proxyPoolDto.js";

describe("proxy pool public DTO", () => {
  it("redacts Mihomo secret and state while exposing configured status", () => {
    const dto = toPublicProxyPool({
      id: "p1",
      type: "mihomo",
      mihomo: {
        controllerUrl: "http://10.11.11.1:9090",
        controllerSecret: "secret",
        selectorName: "selector",
      },
      mihomoState: { proxyProviders: { sub: {} } },
    });

    expect(dto.mihomo).toEqual({
      controllerUrl: "http://10.11.11.1:9090",
      selectorName: "selector",
      controllerSecretConfigured: true,
    });
    expect(dto).not.toHaveProperty("controllerSecret");
    expect(dto).not.toHaveProperty("mihomoState");
    expect(JSON.stringify(dto)).not.toContain("secret");
  });

  it("keeps ordinary pool response compatibility and maps lists", () => {
    const pool = { id: "p1", type: "http", proxyUrl: "http://proxy" };
    expect(toPublicProxyPool(pool)).toEqual(pool);
    expect(toPublicProxyPools([pool])).toEqual([pool]);
  });
});
