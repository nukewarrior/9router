import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let db;
let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mihomo-state-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("../../src/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Mihomo proxy pool state persistence", () => {
  it("persists backend config and merges concurrent-style atomic mutations", async () => {
    const pool = await db.createProxyPool({
      name: "OpenCode via Nikki",
      type: "mihomo",
      proxyUrl: "http://198.51.100.10:18080",
      mihomo: {
        controllerUrl: "http://192.0.2.10:9090",
        controllerSecret: "secret",
        selectorName: "Test Selector",
      },
    });

    expect(pool.strictProxy).toBe(true);
    expect(pool.mihomo.controllerSecret).toBe("secret");
    expect(pool.mihomoState).toMatchObject({ version: 2, proxyProviders: {}, egressIdentities: {} });

    await db.mutateProxyPool(pool.id, (current) => {
      current.mihomoState.proxyProviders.subA = { nodes: { "Example Taiwan Node A": { business: {} } } };
      return current;
    });
    await db.mutateProxyPool(pool.id, (current) => {
      current.mihomoState.proxyProviders.subB = { nodes: { "Example Japan Node A": { business: {} } } };
      return current;
    });

    const stored = await db.getProxyPoolById(pool.id);
    expect(stored.mihomoState.proxyProviders).toEqual({
      subA: { nodes: { "Example Taiwan Node A": { business: {} } } },
      subB: { nodes: { "Example Japan Node A": { business: {} } } },
    });

    await db.deleteProxyPool(pool.id);
  });
});
