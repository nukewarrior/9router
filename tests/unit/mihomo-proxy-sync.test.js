import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const controllerMocks = vi.hoisted(() => ({
  getMihomoProviderProxies: vi.fn(),
  getMihomoProxies: vi.fn(),
  getMihomoVersion: vi.fn(),
}));

vi.mock("@/lib/network/mihomoController.js", () => ({
  getMihomoProviderProxies: controllerMocks.getMihomoProviderProxies,
  getMihomoProxies: controllerMocks.getMihomoProxies,
  getMihomoVersion: controllerMocks.getMihomoVersion,
  MihomoControllerError: class MihomoControllerError extends Error {},
  validateMihomoControllerConfig: (config) => ({
    ...config,
    providerNames: config.providerNames || [],
    syncIntervalMinutes: config.syncIntervalMinutes || 5,
  }),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let sync;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mihomo-sync-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  sync = await import("@/shared/services/mihomoProxySync.js");
  await db.initDb();
});

afterAll(() => {
  sync?.stopMihomoSyncScheduler();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.clearAllMocks();
  controllerMocks.getMihomoProviderProxies.mockResolvedValue({});
  controllerMocks.getMihomoProxies.mockResolvedValue({});
});

describe("Mihomo node preview", () => {
  it("discovers providers and Selector groups before a selection is configured", async () => {
    controllerMocks.getMihomoVersion.mockResolvedValue({ meta: true, version: "1.19.0" });
    controllerMocks.getMihomoProviderProxies.mockResolvedValue({
      airport: {
        vehicleType: "HTTP",
        proxies: [{ name: "node-a", type: "Shadowsocks", alive: true }],
      },
    });
    controllerMocks.getMihomoProxies.mockResolvedValue({
      primary: { type: "Selector", all: ["node-a"], now: "node-a" },
    });

    const result = await sync.testMihomoController({
      id: "controller-discovery",
      enabled: true,
      controllerUrl: "http://127.0.0.1:9090",
      proxyUrl: "http://127.0.0.1:7890",
      secret: "",
      providerNames: [],
      selectorName: "",
      syncIntervalMinutes: 5,
    });

    expect(result.version).toEqual({ meta: true, version: "1.19.0" });
    expect(result.providers).toEqual([{
      name: "airport",
      vehicleType: "HTTP",
      nodeCount: 1,
      nodes: [{ name: "node-a", type: "Shadowsocks", alive: true }],
    }]);
    expect(result.selectors).toEqual([{
      name: "primary",
      all: ["node-a"],
      now: "node-a",
    }]);
    expect(result.preview).toEqual({ eligible: [], excluded: [], duplicates: [] });
  });

  it("intersects provider nodes with Selector.all and excludes duplicate names", () => {
    const preview = sync.buildMihomoNodePreview({
      providers: {
        first: { proxies: [{ name: "node-a", alive: true }, { name: "shared" }] },
        second: { proxies: [{ name: "node-b", alive: false }, { name: "shared" }] },
      },
      proxies: {
        primary: { type: "Selector", all: ["node-a", "node-b", "shared"] },
      },
      providerNames: ["first", "second"],
      selectorName: "primary",
    });

    expect(preview.eligible).toEqual([
      { providerName: "first", nodeName: "node-a", type: null, sourceAlive: true },
      { providerName: "second", nodeName: "node-b", type: null, sourceAlive: false },
    ]);
    expect(preview.duplicates).toEqual([
      { nodeName: "shared", name: "shared", providerNames: ["first", "second"] },
    ]);
    expect(preview.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerName: "first", nodeName: "shared", reason: "duplicate-node-name" }),
      expect.objectContaining({ providerName: "second", nodeName: "shared", reason: "duplicate-node-name" }),
    ]));
  });
});

describe("Mihomo proxy-pool mirror", () => {
  it("creates stable pools, is idempotent, preserves state, and marks disappearance/recovery", async () => {
    const ordinary = await db.createProxyPool({
      id: "ordinary-pool",
      name: "ordinary",
      proxyUrl: "http://ordinary.example",
      type: "http",
    });
    const aId = sync.buildMihomoPoolId("controller-1", "first", "node-a");
    const bId = sync.buildMihomoPoolId("controller-1", "second", "node-b");
    const entries = [
      { id: aId, providerName: "first", nodeName: "node-a", sourceAlive: true, lastSeenAt: "2026-08-13T00:00:00.000Z" },
      { id: bId, providerName: "second", nodeName: "node-b", sourceAlive: false, lastSeenAt: "2026-08-13T00:00:00.000Z" },
    ];

    await expect(db.syncMihomoProxyPools({
      controllerId: "controller-1",
      proxyUrl: "http://127.0.0.1:7890",
      selectorName: "primary",
      entries,
      now: "2026-08-13T00:00:00.000Z",
    })).resolves.toMatchObject({ created: 2, markedUnavailable: 0 });

    const createdA = await db.getProxyPoolById(aId);
    const createdAt = createdA.createdAt;
    await db.updateProxyPool(aId, {
      isActive: false,
      rateLimitState: { opencode: { cooldownUntil: "2026-08-13T00:10:00.000Z" } },
    });

    await expect(db.syncMihomoProxyPools({
      controllerId: "controller-1",
      proxyUrl: "http://127.0.0.1:7890",
      selectorName: "primary",
      entries,
      now: "2026-08-13T00:01:00.000Z",
    })).resolves.toMatchObject({ created: 0, recovered: 0 });

    const idempotentA = await db.getProxyPoolById(aId);
    expect(idempotentA.createdAt).toBe(createdAt);
    expect(idempotentA.isActive).toBe(false);
    expect(idempotentA.rateLimitState).toEqual({ opencode: { cooldownUntil: "2026-08-13T00:10:00.000Z" } });

    await db.syncMihomoProxyPools({
      controllerId: "controller-1",
      proxyUrl: "http://127.0.0.1:7890",
      selectorName: "primary",
      entries: [entries[1]],
      now: "2026-08-13T00:02:00.000Z",
    });
    const unavailableA = await db.getProxyPoolById(aId);
    const untouchedOrdinary = await db.getProxyPoolById(ordinary.id);
    expect(unavailableA.sourceAvailable).toBe(false);
    expect(unavailableA.isActive).toBe(false);
    expect(unavailableA.rateLimitState).toEqual({ opencode: { cooldownUntil: "2026-08-13T00:10:00.000Z" } });
    expect(untouchedOrdinary.type).toBe("http");
    expect(untouchedOrdinary.sourceAvailable).toBeUndefined();

    await expect(db.syncMihomoProxyPools({
      controllerId: "controller-1",
      proxyUrl: "http://127.0.0.1:7890",
      selectorName: "primary",
      entries: [entries[0]],
      now: "2026-08-13T00:03:00.000Z",
    })).resolves.toMatchObject({ recovered: 1 });
    const recoveredA = await db.getProxyPoolById(aId);
    expect(recoveredA.sourceAvailable).toBe(true);
    expect(recoveredA.isActive).toBe(false);
    expect(recoveredA.rateLimitState).toEqual({ opencode: { cooldownUntil: "2026-08-13T00:10:00.000Z" } });
  });

  it("shares one in-flight sync between concurrent scheduler callers", async () => {
    await db.updateMihomoControllerConfig({
      id: "controller-2",
      enabled: true,
      controllerUrl: "http://127.0.0.1:9090",
      secret: "server-secret",
      proxyUrl: "http://127.0.0.1:7890",
      selectorName: "primary",
      providerNames: ["first"],
      syncIntervalMinutes: 5,
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    controllerMocks.getMihomoProviderProxies.mockReturnValue(gate.then(() => ({ first: { proxies: [{ name: "node-c" }] } })));
    controllerMocks.getMihomoProxies.mockResolvedValue({ primary: { type: "Selector", all: ["node-c"] } });

    const first = sync.syncMihomoControllerSingleFlight();
    const second = sync.syncMihomoControllerSingleFlight();
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ summary: { created: 1 } });
    expect(controllerMocks.getMihomoProviderProxies).toHaveBeenCalledTimes(1);
  });
});
