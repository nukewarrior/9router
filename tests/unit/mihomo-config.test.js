import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS,
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
      inventoryRefreshMs: 1,
      maxAttemptsPerRequest: 999,
      egressProbeTtlMs: 1,
      samplesPerNode: 1,
      businessHealthRefreshMs: 1,
      businessHealthTtlMs: 1,
      businessProbeTimeoutMs: 999999,
      admissionWaitMs: -1,
      maxInFlightStartsPerEgress: 999,
      cooldown: { baseMs: 1, multiplier: 99, maxMs: 2 },
    });

    expect(config.controllerTimeoutMs).toBe(30000);
    expect(config.syncTtlMs).toBe(1000);
    expect(config.inventoryRefreshMs).toBe(60000);
    expect(config.maxAttemptsPerRequest).toBe(50);
    expect(config.egressProbeTtlMs).toBe(300000);
    expect(config.samplesPerNode).toBe(2);
    expect(config.businessHealthRefreshMs).toBe(60000);
    expect(config.businessHealthTtlMs).toBe(120000);
    expect(config.businessProbeTimeoutMs).toBe(60000);
    expect(config.admissionWaitMs).toBe(0);
    expect(config.maxInFlightStartsPerEgress).toBe(10);
    expect(config.cooldown).toEqual({ baseMs: 1000, multiplier: 10, maxMs: 1000 });
    expect(config.maintenanceBackoffMs).toEqual(DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS);
    expect(config).not.toHaveProperty("regionOrder");
    expect(config).not.toHaveProperty("preferDistinctEgress");
    expect(config).not.toHaveProperty("egressScopedCooldown");
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
    expect(config.businessHealthRefreshMs).toBe(900000);
    expect(config.businessHealthTtlMs).toBe(2700000);
    expect(config.businessProbeTimeoutMs).toBe(15000);
    expect(config.admissionWaitMs).toBe(3000);
    expect(config.maxInFlightStartsPerEgress).toBe(1);
  });

  it("ignores legacy Region and egress flags instead of writing them back", () => {
    const config = normalizeMihomoConfig({
      ...baseConfig,
      regionOrder: ["US"],
      preferDistinctEgress: true,
      egressScopedCooldown: true,
    });
    expect(config).not.toHaveProperty("regionOrder");
    expect(config).not.toHaveProperty("preferDistinctEgress");
    expect(config).not.toHaveProperty("egressScopedCooldown");
  });

  it("requires an HTTPS egress probe URL", () => {
    expect(() => normalizeMihomoConfig({ ...baseConfig, egressProbeUrl: "http://probe.example.test" })).toThrow(/HTTPS/);
  });
});
