import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIHOMO_REGION_ORDER,
  mergeMihomoConfig,
  normalizeMihomoConfig,
} from "../../src/lib/network/mihomoConfig.js";

const baseConfig = {
  controllerUrl: "http://192.0.2.10:9090",
  controllerSecret: "secret",
  selectorName: "Test Selector",
};

describe("Mihomo pool configuration", () => {
  it("normalizes safe bounds and defaults", () => {
    const config = normalizeMihomoConfig({
      ...baseConfig,
      controllerTimeoutMs: 999999,
      syncTtlMs: 1,
      maxAttemptsPerRequest: 999,
      cooldown: { baseMs: 1, multiplier: 99, maxMs: 2 },
    });

    expect(config.controllerTimeoutMs).toBe(30000);
    expect(config.syncTtlMs).toBe(1000);
    expect(config.maxAttemptsPerRequest).toBe(50);
    expect(config.cooldown).toEqual({ baseMs: 1000, multiplier: 10, maxMs: 1000 });
    expect(config.regionOrder).toEqual(DEFAULT_MIHOMO_REGION_ORDER);
  });

  it("validates required fields and regexes", () => {
    expect(() => normalizeMihomoConfig({ selectorName: "selector" })).toThrow(/controllerUrl/);
    expect(() => normalizeMihomoConfig({ ...baseConfig, includeRegex: "[" })).toThrow(/regular expression/);
  });

  it("merges partial edits without dropping the existing secret", () => {
    const merged = mergeMihomoConfig(baseConfig, { selectorName: "new-selector" });
    expect(merged.controllerSecret).toBe("secret");
    expect(merged.selectorName).toBe("new-selector");
  });

  it("defaults discovery safely without enabling routing changes", () => {
    const config = normalizeMihomoConfig(baseConfig);
    expect(config.egressProbeUrl).toBe("https://api.ipify.org/");
    expect(config.samplesPerNode).toBe(2);
    expect(config.egressProbeTtlMs).toBe(21600000);
    expect(config.preferDistinctEgress).toBe(false);
    expect(config.egressScopedCooldown).toBe(false);
  });

  it("requires an HTTPS egress probe URL", () => {
    expect(() => normalizeMihomoConfig({ ...baseConfig, egressProbeUrl: "http://probe.example.test" })).toThrow(/HTTPS/);
  });
});
