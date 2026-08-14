import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { mihomoAdminErrorResponse } from "@/lib/network/mihomoAdmin.js";
import {
  probeMihomoNodesEgress,
  toPublicMihomoEgressProbeResponse,
} from "@/lib/network/mihomoEgressDiscovery.js";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    if (!isMihomoProxyPool(pool)) return NextResponse.json({ error: "Proxy pool is not Mihomo managed" }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const hasNode = text(body?.nodeName);
    const result = await probeMihomoNodesEgress({
      poolId: id,
      region: text(body?.region) || null,
      proxyProvider: text(body?.proxyProvider) || null,
      nodeName: hasNode || null,
      limit: body?.limit,
      force: hasNode ? true : body?.force === true,
      queueOnly: true,
    });

    return NextResponse.json(toPublicMihomoEgressProbeResponse(result), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const result = mihomoAdminErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
