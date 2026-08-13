import { describe, expect, it, vi } from "vitest";
import { executeMihomoNoAuthRoute } from "../../src/sse/handlers/chat.js";

function response(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function credentials() {
  return {
    id: "noauth",
    providerSpecificData: {
      connectionProxyPoolId: "pool-1",
      mihomoManaged: true,
    },
  };
}

function route(nodeName, region, attempt) {
  return {
    proxyPoolId: "pool-1",
    proxyProvider: "subscription",
    nodeName,
    region,
    selectorName: "selector",
    attempt,
  };
}

describe("Mihomo no-auth route fallback", () => {
  it("rotates from a rate-limited region and returns the next node response", async () => {
    const preparedRoutes = [route("TW-A30", "TW", 1), route("JP-A01", "JP", 2)];
    const prepareRoute = vi.fn(async ({ routeContext }) => {
      const next = preparedRoutes[routeContext.attempts];
      if (!next) {
        return {
          route: null,
          directory: { nodes: preparedRoutes },
          effectiveMaxAttempts: 2,
          earliestCooldown: new Date(Date.now() + 300000).toISOString(),
        };
      }
      routeContext.attempts += 1;
      routeContext.attemptedNodeKeys.add(`subscription\0${next.nodeName}`);
      return { route: next, directory: { nodes: preparedRoutes }, effectiveMaxAttempts: 2 };
    });
    const executeAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: 500,
        error: "FreeUsageLimitError",
        response: response(500, { error: "limit" }),
      })
      .mockResolvedValueOnce({ success: true, response: response(200, { ok: true }) });
    const leaseRoute = vi.fn(async ({ nodeName }, callback) => callback({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://router:17891",
      strictProxy: true,
      ephemeralProxyDispatcher: true,
      mihomoManaged: true,
    }, { nodeName }));
    const recordFailure = vi.fn(async () => ({ updated: true, cooldownMs: 300000 }));
    const recordSuccess = vi.fn(async () => ({ updated: true }));

    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      credentials: credentials(),
      deps: { prepareRoute, executeAttempt, leaseRoute, recordFailure, recordSuccess },
    });

    expect(result.status).toBe(200);
    expect(executeAttempt).toHaveBeenCalledTimes(2);
    expect(leaseRoute.mock.calls.map(([args]) => args.nodeName)).toEqual(["TW-A30", "JP-A01"]);
    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      businessProviderId: "opencode",
      route: expect.objectContaining({ nodeName: "TW-A30" }),
    }));
    expect(recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      businessProviderId: "opencode",
      route: expect.objectContaining({ nodeName: "JP-A01" }),
    }));
    expect(executeAttempt.mock.calls[1][0].proxyOptionsOverride).toMatchObject({
      strictProxy: true,
      ephemeralProxyDispatcher: true,
      mihomoManaged: true,
    });
  });

  it("returns Retry-After when every remaining candidate is cooling down", async () => {
    const cooldownUntil = new Date(Date.now() + 120000).toISOString();
    const prepareRoute = vi.fn()
      .mockResolvedValueOnce({
        route: route("TW-A30", "TW", 1),
        directory: { nodes: [route("TW-A30", "TW", 1), route("JP-A01", "JP", 1)] },
        effectiveMaxAttempts: 1,
      })
      .mockResolvedValueOnce({
        route: null,
        directory: { nodes: [route("TW-A30", "TW", 1), route("JP-A01", "JP", 1)] },
        effectiveMaxAttempts: 1,
        earliestCooldown: cooldownUntil,
      });
    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      credentials: credentials(),
      deps: {
        prepareRoute,
        leaseRoute: async (_args, callback) => callback({}, {}),
        executeAttempt: async () => ({ success: false, status: 429, error: "rate limit", response: response(429) }),
        recordFailure: async () => ({ updated: true, cooldownMs: 120000 }),
      },
    });

    expect(result.status).toBe(429);
    expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await result.json()).toMatchObject({ error: { message: expect.stringContaining("temporarily rate-limited") } });
  });

  it("does not rotate non-rate-limit failures", async () => {
    const executeAttempt = vi.fn().mockResolvedValue({
      success: false,
      status: 401,
      error: "invalid credentials",
      response: response(401),
    });
    const prepareRoute = vi.fn().mockResolvedValue({
      route: route("TW-A30", "TW", 1),
      directory: { nodes: [route("TW-A30", "TW", 1)] },
      effectiveMaxAttempts: 1,
    });
    const recordFailure = vi.fn();
    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      credentials: credentials(),
      deps: {
        prepareRoute,
        leaseRoute: async (_args, callback) => callback({}, {}),
        executeAttempt,
        recordFailure,
      },
    });

    expect(result.status).toBe(401);
    expect(prepareRoute).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
