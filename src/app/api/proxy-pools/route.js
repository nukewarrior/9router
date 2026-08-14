import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";
import { PROXY_POOL_TYPES, isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";
import { normalizeMihomoConfig } from "@/lib/network/mihomoConfig.js";
import { toPublicProxyPool, toPublicProxyPools } from "@/lib/network/proxyPoolDto.js";
import { wakeMihomoMaintenance } from "@/lib/network/mihomoMaintenanceService.js";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  let strictProxy = body?.strictProxy === true;
  const type = PROXY_POOL_TYPES.has(body?.type) ? body.type : "http";

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  const normalized = { name, proxyUrl, noProxy, isActive, strictProxy, type };
  if (isMihomoProxyPool(type)) {
    const mihomo = body?.mihomo && typeof body.mihomo === "object" ? { ...body.mihomo } : {};
    if (!mihomo.controllerSecret && typeof body?.controllerSecret === "string") {
      mihomo.controllerSecret = body.controllerSecret;
    }
    normalized.mihomo = normalizeMihomoConfig(mihomo);
    normalized.strictProxy = true;
  }

  return normalized;
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const proxyPools = await getProxyPools(filter);

    if (!includeUsage) {
      return NextResponse.json({ proxyPools: toPublicProxyPools(proxyPools) });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = proxyPools.map((pool) => ({
      ...pool,
      boundConnectionCount: usageMap.get(pool.id) || 0,
    }));

    return NextResponse.json({ proxyPools: toPublicProxyPools(enrichedProxyPools) });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    let normalized;
    try {
      normalized = normalizeProxyPoolInput(body);
    } catch (error) {
      return NextResponse.json({ error: error.message || "Invalid Mihomo configuration" }, { status: 400 });
    }

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    if (isMihomoProxyPool(proxyPool)) {
      void wakeMihomoMaintenance(proxyPool.id, "pool-created").catch(() => {});
    }
    return NextResponse.json({ proxyPool: toPublicProxyPool(proxyPool) }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
