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
      proxyUrl: "http://10.11.11.1:17891",
      mihomo: {
        controllerUrl: "http://10.11.11.1:9090",
        controllerSecret: "secret",
        selectorName: "🤖 OpenCode调度",
      },
    });

    expect(pool.strictProxy).toBe(true);
    expect(pool.mihomo.controllerSecret).toBe("secret");
    expect(pool.mihomoState).toEqual({ proxyProviders: {} });

    await db.mutateProxyPool(pool.id, (current) => {
      current.mihomoState.proxyProviders.subA = { nodes: { "TW-A30": { business: {} } } };
      return current;
    });
    await db.mutateProxyPool(pool.id, (current) => {
      current.mihomoState.proxyProviders.subB = { nodes: { "JP-A01": { business: {} } } };
      return current;
    });

    const stored = await db.getProxyPoolById(pool.id);
    expect(stored.mihomoState.proxyProviders).toEqual({
      subA: { nodes: { "TW-A30": { business: {} } } },
      subB: { nodes: { "JP-A01": { business: {} } } },
    });

    await db.deleteProxyPool(pool.id);
  });
});
