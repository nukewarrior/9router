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

function route(nodeName, identityKey, attempt = 1) {
  const proxyProvider = "subscription";
  return {
    proxyPoolId: "pool-1",
    modelId: "oc-model-a",
    proxyProvider,
    nodeName,
    nodeKey: `${proxyProvider}\0${nodeName}`,
    region: "OTHER",
    selectorName: "selector",
    attempt,
    maxAttempts: 2,
    attemptStartedAtMs: 1000 + attempt,
    mappingVersion: 1,
    egressIdentityKey: identityKey,
    egressSnapshot: {
      identityKey,
      confidence: "stable",
      expiresAt: 9999999999999,
      evidenceVersion: 1,
      scopeEligible: true,
    },
  };
}

function entry(identityKey, nodes) {
  return {
    identityKey,
    evidenceVersion: 1,
    expiresAt: 9999999999999,
    nodes: nodes.map((nodeName) => ({
      key: `subscription\0${nodeName}`,
      proxyProvider: "subscription",
      nodeName,
      mappingVersion: 1,
    })),
  };
}

function prepared(routeValue, entryValue, release = vi.fn()) {
  return {
    route: routeValue,
    entry: entryValue,
    reservation: { release },
    effectiveMaxAttempts: 2,
    snapshot: { entries: [entryValue] },
  };
}

function baseDeps(overrides = {}) {
  const pool = { id: "pool-1", type: "mihomo", isActive: true };
  return {
    getPool: vi.fn().mockResolvedValue(pool),
    rebuildSnapshot: vi.fn(),
    leaseRoute: vi.fn(async ({ nodeName }, callback) => callback({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://router:18080",
      strictProxy: true,
      ephemeralProxyDispatcher: true,
      mihomoManaged: true,
      nodeName,
    })),
    ...overrides,
  };
}

describe("Mihomo no-auth route fallback", () => {
  it("switches to a distinct egress after an IP-candidate 429", async () => {
    const firstRoute = route("Node-A", "4:198.51.100.10");
    const secondRoute = route("Node-B", "4:198.51.100.11", 2);
    const firstEntry = entry(firstRoute.egressIdentityKey, [firstRoute.nodeName]);
    const secondEntry = entry(secondRoute.egressIdentityKey, [secondRoute.nodeName]);
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const prepareRoute = vi.fn(async ({ routeContext }) => {
      if (routeContext.attempts === 0) {
        routeContext.attempts = 1;
        return prepared(firstRoute, firstEntry, firstRelease);
      }
      if (routeContext.attempts === 1) {
        routeContext.attempts = 2;
        return prepared(secondRoute, secondEntry, secondRelease);
      }
      return { route: null, effectiveMaxAttempts: 2 };
    });
    const executeAttempt = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "rate limit",
        response: response(429, { error: "limit" }),
      })
      .mockResolvedValueOnce({ success: true, response: response(200, { ok: true }) });
    const recordFailure = vi.fn().mockResolvedValue({
      updated: true,
      cooldownMs: 300000,
      pool: { id: "pool-1", type: "mihomo", isActive: true },
    });
    const recordSuccess = vi.fn().mockResolvedValue({
      updated: true,
      pool: { id: "pool-1", type: "mihomo", isActive: true },
    });
    const deps = baseDeps({ prepareRoute, executeAttempt, recordFailure, recordSuccess });

    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "oc-model-a",
      credentials: credentials(),
      clientRawRequest: { headers: { "x-request-id": "client-req-1" } },
      deps,
    });

    expect(result.status).toBe(200);
    expect(executeAttempt).toHaveBeenCalledTimes(2);
    expect(deps.leaseRoute.mock.calls.map(([args]) => args.nodeName)).toEqual(["Node-A", "Node-B"]);
    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "oc-model-a",
      route: expect.objectContaining({ egressIdentityKey: "4:198.51.100.10" }),
    }));
    expect(recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "oc-model-a",
      route: expect.objectContaining({ egressIdentityKey: "4:198.51.100.11" }),
    }));
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(deps.leaseRoute.mock.calls[1][0].priority).toBe(0);
    expect(deps.leaseRoute.mock.calls[1][0].route.egressIdentityKey)
      .not.toBe(deps.leaseRoute.mock.calls[0][0].route.egressIdentityKey);
    expect(prepareRoute.mock.calls[0][0].routeContext.requestId).toBe("client-req-1");
    expect(prepareRoute.mock.calls[1][0].routeContext.routeId)
      .toBe(prepareRoute.mock.calls[0][0].routeContext.routeId);
  });

  it("releases the reservation, then tries a same-IP backup before another egress", async () => {
    const firstRoute = route("Node-A1", "4:198.51.100.20");
    const backupRoute = route("Node-A2", "4:198.51.100.20");
    const sameEntry = entry(firstRoute.egressIdentityKey, [firstRoute.nodeName, backupRoute.nodeName]);
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const events = [];
    firstRelease.mockImplementation(() => events.push("release-first"));
    secondRelease.mockImplementation(() => events.push("release-backup"));
    const prepareRoute = vi.fn(async ({ routeContext }) => {
      if (routeContext.attempts === 0) {
        routeContext.attempts = 1;
        return prepared(firstRoute, sameEntry, firstRelease);
      }
      expect(routeContext.preferredEgressKey).toBe(firstRoute.egressIdentityKey);
      return prepared(backupRoute, sameEntry, secondRelease);
    });
    const leaseRoute = vi.fn(async ({ nodeName }, callback) => {
      events.push(`lease-${nodeName}`);
      return callback({ strictProxy: true, ephemeralProxyDispatcher: true });
    });
    const executeAttempt = vi.fn()
      .mockImplementationOnce(async () => ({
        success: false,
        status: 502,
        error: "fetch failed",
        response: response(502),
      }))
      .mockResolvedValueOnce({ success: true, response: response(200, { ok: true }) });
    const recordTransportFailure = vi.fn(async () => {
      events.push("record-transport-failure");
      return { updated: true, pool: { id: "pool-1", type: "mihomo", isActive: true } };
    });
    const deps = baseDeps({
      prepareRoute,
      leaseRoute,
      executeAttempt,
      recordTransportFailure,
      recordTransportSuccess: vi.fn().mockResolvedValue({ updated: true }),
      recordSuccess: vi.fn().mockResolvedValue({
        updated: true,
        pool: { id: "pool-1", type: "mihomo", isActive: true },
      }),
    });

    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "oc-model-a",
      credentials: credentials(),
      deps,
    });

    expect(result.status).toBe(200);
    expect(deps.leaseRoute.mock.calls.map(([args]) => args.route.nodeName)).toEqual(["Node-A1", "Node-A2"]);
    expect(recordTransportFailure).toHaveBeenCalledWith(expect.objectContaining({
      route: expect.objectContaining({ nodeName: "Node-A1" }),
    }));
    expect(events.indexOf("release-first")).toBeLessThan(events.indexOf("record-transport-failure"));
    expect(events.indexOf("record-transport-failure")).toBeLessThan(events.indexOf("lease-Node-A2"));
    expect(deps.leaseRoute.mock.calls[1][0].route.egressIdentityKey).toBe("4:198.51.100.20");
  });

  it("moves to a distinct egress after every node in the current group fails transport", async () => {
    const firstRoute = route("Node-A", "4:198.51.100.30");
    const secondRoute = route("Node-B", "4:198.51.100.31", 2);
    const prepareRoute = vi.fn(async ({ routeContext }) => {
      if (routeContext.attempts === 0) {
        routeContext.attempts = 1;
        return prepared(firstRoute, entry(firstRoute.egressIdentityKey, [firstRoute.nodeName]));
      }
      if (routeContext.attempts === 1) {
        routeContext.attempts = 2;
        return prepared(secondRoute, entry(secondRoute.egressIdentityKey, [secondRoute.nodeName]));
      }
      return { route: null, effectiveMaxAttempts: 2 };
    });
    const executeAttempt = vi.fn()
      .mockResolvedValueOnce({ success: false, status: 502, error: "UND_ERR_CONNECT_TIMEOUT", response: response(502) })
      .mockResolvedValueOnce({ success: false, status: 502, error: "connect timeout", response: response(502) });
    const recordTransportFailure = vi.fn().mockResolvedValue({
      updated: true,
      pool: { id: "pool-1", type: "mihomo", isActive: true },
    });
    const deps = baseDeps({
      prepareRoute,
      executeAttempt,
      recordTransportFailure,
      recordSuccess: vi.fn(),
    });

    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "oc-model-a",
      credentials: credentials(),
      deps,
    });

    expect(result.status).toBe(503);
    expect(executeAttempt).toHaveBeenCalledTimes(2);
    expect(recordTransportFailure).toHaveBeenCalledTimes(2);
    expect(deps.leaseRoute.mock.calls.map(([args]) => args.route.egressIdentityKey)).toEqual([
      "4:198.51.100.30",
      "4:198.51.100.31",
    ]);
  });

  it("returns ordinary HTTP 4xx/5xx without switching or recording route failure", async () => {
    const preparedRoute = route("Node-A", "4:198.51.100.40");
    const prepareRoute = vi.fn().mockResolvedValue({
      route: preparedRoute,
      entry: entry(preparedRoute.egressIdentityKey, [preparedRoute.nodeName]),
      reservation: { release: vi.fn() },
      effectiveMaxAttempts: 1,
    });
    const recordFailure = vi.fn();
    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "oc-model-a",
      credentials: credentials(),
      deps: {
        ...baseDeps({ prepareRoute }),
        executeAttempt: vi.fn().mockResolvedValue({
          success: false,
          status: 500,
          error: "Internal Server Error",
          response: response(500),
        }),
        recordFailure,
      },
    });

    expect(result.status).toBe(500);
    expect(prepareRoute).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when every egress is rate-limited", async () => {
    const firstRoute = route("Node-A", "4:198.51.100.50");
    const secondRoute = route("Node-B", "4:198.51.100.51", 2);
    const prepareRoute = vi.fn(async ({ routeContext }) => {
      if (routeContext.attempts === 0) {
        routeContext.attempts = 1;
        return prepared(firstRoute, entry(firstRoute.egressIdentityKey, [firstRoute.nodeName]));
      }
      if (routeContext.attempts === 1) {
        routeContext.attempts = 2;
        return prepared(secondRoute, entry(secondRoute.egressIdentityKey, [secondRoute.nodeName]));
      }
      return { route: null, effectiveMaxAttempts: 2 };
    });
    const recordFailure = vi.fn().mockResolvedValue({
      updated: true,
      cooldownMs: 120000,
      pool: { id: "pool-1", type: "mihomo", isActive: true },
    });
    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "oc-model-a",
      credentials: credentials(),
      deps: baseDeps({
        prepareRoute,
        executeAttempt: vi.fn().mockResolvedValue({
          success: false,
          status: 429,
          error: "rate limit",
          response: response(429),
        }),
        recordFailure,
      }),
    });

    expect(result.status).toBe(429);
    expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(recordFailure).toHaveBeenCalledTimes(2);
    expect(recordFailure.mock.calls[0][0].modelId).toBe("oc-model-a");
    expect(recordFailure.mock.calls[1][0].modelId).toBe("oc-model-a");
  });

  it.each([
    ["MIHOMO_POOL_WARMING", 503],
    ["MIHOMO_POOL_SATURATED", 503],
    ["MIHOMO_NO_ELIGIBLE_NODES", 503],
  ])("maps %s to a fail-closed unavailable response", async (code, status) => {
    const prepareRoute = vi.fn().mockRejectedValue(Object.assign(new Error(code), {
      code,
      retryAfter: new Date(Date.now() + 1000).toISOString(),
    }));
    const result = await executeMihomoNoAuthRoute({
      body: { messages: [], stream: false },
      provider: "opencode",
      model: "oc-model-a",
      credentials: credentials(),
      deps: baseDeps({ prepareRoute }),
    });
    expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({ error: { message: expect.stringContaining(code) } });
  });
});
