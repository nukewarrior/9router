import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getProxyPoolById: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
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

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
  getProxyPoolById: mocks.getProxyPoolById,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    genSalt: vi.fn(),
    hash: vi.fn(),
  },
}));

vi.mock("@/lib/network/proxyPoolTypes.js", () => ({
  isMihomoProxyPool: (pool) => pool?.type === "mihomo",
}));

const { PATCH } = await import("../../src/app/api/settings/route.js");

function request(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/settings Mihomo provider strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ providerStrategies: {} });
    mocks.updateSettings.mockImplementation(async (updates) => ({ providerStrategies: updates.providerStrategies || {} }));
    mocks.getProxyPoolById.mockImplementation(async (id) => ({ id, type: id === "mihomo" ? "mihomo" : "http" }));
  });

  it.each([
    ["undefined", { proxyPoolId: "mihomo" }],
    ["none", { proxyPoolId: "mihomo", rotateStrategy: "none" }],
  ])("allows a fixed Mihomo pool with rotateStrategy %s", async (_label, strategy) => {
    const response = await PATCH(request({ providerStrategies: { opencode: strategy } }));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
  });

  it.each(["round-robin", "random"])("rejects Mihomo outer rotation: %s", async (rotateStrategy) => {
    const response = await PATCH(request({
      providerStrategies: { opencode: { proxyPoolId: "mihomo", rotateStrategy } },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("outer pool rotation") });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps round-robin valid for an ordinary HTTP pool", async () => {
    const response = await PATCH(request({
      providerStrategies: { opencode: { proxyPoolId: "http-pool", rotateStrategy: "round-robin" } },
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
  });
});
