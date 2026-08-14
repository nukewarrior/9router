import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  buildMihomoHealthDto: vi.fn(),
  validateMihomoHealthRefresh: vi.fn(),
  refreshMihomoMaintenance: vi.fn(),
  clearMihomoEgressCooldown: vi.fn(),
  clearMihomoNodeTransportCooldown: vi.fn(),
  rebuildHealthyMihomoSnapshot: vi.fn(),
  HealthAdminError: class HealthAdminError extends Error {
    constructor(code, message, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
}));

vi.mock("@/lib/network/mihomoHealthAdmin.js", () => ({
  MihomoHealthAdminError: mocks.HealthAdminError,
  buildMihomoHealthDto: mocks.buildMihomoHealthDto,
  validateMihomoHealthRefresh: mocks.validateMihomoHealthRefresh,
}));

vi.mock("@/lib/network/mihomoMaintenanceService.js", () => ({
  refreshMihomoMaintenance: mocks.refreshMihomoMaintenance,
}));

vi.mock("@/lib/network/mihomoState.js", async () => ({
  ...(await vi.importActual("@/lib/network/mihomoState.js")),
  clearMihomoEgressCooldown: mocks.clearMihomoEgressCooldown,
  clearMihomoNodeTransportCooldown: mocks.clearMihomoNodeTransportCooldown,
}));

vi.mock("@/lib/network/mihomoHealthPool.js", () => ({
  rebuildHealthyMihomoSnapshot: mocks.rebuildHealthyMihomoSnapshot,
}));

const { GET: getHealth } = await import("../../src/app/api/proxy-pools/[id]/mihomo/health/route.js");
const { POST: refreshHealth } = await import("../../src/app/api/proxy-pools/[id]/mihomo/health/refresh/route.js");
const { GET: getNodes } = await import("../../src/app/api/proxy-pools/[id]/mihomo/nodes/route.js");
const { POST: clearNodeTransport } = await import("../../src/app/api/proxy-pools/[id]/mihomo/clear-cooldown/route.js");
const { POST: clearModelCooldown } = await import("../../src/app/api/proxy-pools/[id]/mihomo/clear-egress-cooldown/route.js");

function request(url, body = null) {
  return new Request(url, body === null ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id = "pool-1") {
  return { params: Promise.resolve({ id }) };
}

describe("Mihomo health API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProxyPoolById.mockResolvedValue({ id: "pool-1", type: "mihomo", isActive: true });
    mocks.buildMihomoHealthDto.mockReturnValue({
      poolId: "pool-1",
      status: "warming",
      cycle: { id: null },
      models: [],
    });
    mocks.validateMihomoHealthRefresh.mockReturnValue({
      scope: "all",
      modelId: null,
      identityKey: null,
    });
    mocks.refreshMihomoMaintenance.mockResolvedValue({
      accepted: true,
      deduplicated: false,
    });
    mocks.clearMihomoEgressCooldown.mockResolvedValue({ updated: true, pool: { id: "pool-1" } });
    mocks.clearMihomoNodeTransportCooldown.mockResolvedValue({ updated: true, pool: { id: "pool-1", mihomoState: { version: 2, maintenance: { selectedModels: ["model-a"] } } } });
  });

  it("returns the allowlisted health DTO and model filter without cache", async () => {
    const response = await getHealth(request("http://localhost/api/proxy-pools/pool-1/mihomo/health?model=model-a"), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.buildMihomoHealthDto).toHaveBeenCalledWith({
      pool: expect.objectContaining({ id: "pool-1", type: "mihomo" }),
      modelId: "model-a",
    });
    await expect(response.json()).resolves.toEqual({
      poolId: "pool-1",
      status: "warming",
      cycle: { id: null },
      models: [],
    });
  });

  it("queues manual refresh and always responds with 202", async () => {
    mocks.validateMihomoHealthRefresh.mockReturnValue({
      scope: "egress",
      modelId: "model-a",
      identityKey: "4:198.51.100.20",
    });
    mocks.refreshMihomoMaintenance.mockResolvedValue({ accepted: true, deduplicated: true });

    const response = await refreshHealth(
      request("http://localhost/api/proxy-pools/pool-1/mihomo/health/refresh", {
        scope: "egress",
        modelId: "model-a",
        identityKey: "4:198.51.100.20",
      }),
      params(),
    );

    expect(response.status).toBe(202);
    expect(mocks.refreshMihomoMaintenance).toHaveBeenCalledWith("pool-1", {
      scope: "egress",
      modelId: "model-a",
      identityKey: "4:198.51.100.20",
    });
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      poolId: "pool-1",
      reason: "manual",
      deduplicated: true,
    });
  });

  it("rejects inactive/non-Mihomo refresh targets and keeps Nodes API on the health DTO", async () => {
    mocks.getProxyPoolById.mockResolvedValueOnce({ id: "pool-1", type: "http", isActive: true });
    const nonMihomo = await getHealth(request("http://localhost/api/proxy-pools/pool-1/mihomo/health"), params());
    expect(nonMihomo.status).toBe(400);

    mocks.getProxyPoolById.mockResolvedValueOnce({ id: "pool-1", type: "mihomo", isActive: false });
    mocks.validateMihomoHealthRefresh.mockImplementationOnce(() => {
      throw new mocks.HealthAdminError("MIHOMO_INVALID_CONFIG", "Mihomo proxy pool is inactive", 400);
    });
    const inactive = await refreshHealth(
      request("http://localhost/api/proxy-pools/pool-1/mihomo/health/refresh", { scope: "all" }),
      params(),
    );
    expect(inactive.status).toBe(400);

    mocks.getProxyPoolById.mockResolvedValue({ id: "pool-1", type: "mihomo", isActive: true });
    const nodes = await getNodes(request("http://localhost/api/proxy-pools/pool-1/mihomo/nodes?model=model-a"), params());
    expect(nodes.status).toBe(200);
    expect(mocks.buildMihomoHealthDto).toHaveBeenLastCalledWith({
      pool: expect.objectContaining({ id: "pool-1" }),
      modelId: "model-a",
    });
  });

  it("requires model-scoped and node-transport-scoped cooldown clear requests", async () => {
    const missingModel = await clearModelCooldown(
      request("http://localhost/api/proxy-pools/pool-1/mihomo/clear-egress-cooldown", { identityKey: "4:198.51.100.20" }),
      params(),
    );
    expect(missingModel.status).toBe(400);
    expect(mocks.clearMihomoEgressCooldown).not.toHaveBeenCalled();

    const missingNode = await clearNodeTransport(
      request("http://localhost/api/proxy-pools/pool-1/mihomo/clear-cooldown", { proxyProvider: "subscription" }),
      params(),
    );
    expect(missingNode.status).toBe(400);
    expect(mocks.clearMihomoNodeTransportCooldown).not.toHaveBeenCalled();

    const cleared = await clearModelCooldown(
      request("http://localhost/api/proxy-pools/pool-1/mihomo/clear-egress-cooldown", { identityKey: "4:198.51.100.20", modelId: "model-a" }),
      params(),
    );
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ ok: true, modelId: "model-a", scope: "model-egress" });

    const nodeCleared = await clearNodeTransport(
      request("http://localhost/api/proxy-pools/pool-1/mihomo/clear-cooldown", { proxyProvider: "subscription", nodeName: "Node A" }),
      params(),
    );
    expect(nodeCleared.status).toBe(200);
    await expect(nodeCleared.json()).resolves.toMatchObject({ ok: true, scope: "node-transport" });
    expect(mocks.rebuildHealthyMihomoSnapshot).toHaveBeenCalled();
  });
});
