import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { MihomoAdminError, mihomoAdminErrorResponse } from "@/lib/network/mihomoAdmin.js";
import { probeMihomoNodeEgress, probeMihomoNodesEgress } from "@/lib/network/mihomoEgressDiscovery.js";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function requiredText(value, fieldName) {
  const normalized = text(value);
  if (!normalized) throw new MihomoAdminError("MIHOMO_INVALID_REQUEST", `${fieldName} is required`, 400);
  return normalized;
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    if (!isMihomoProxyPool(pool)) return NextResponse.json({ error: "Proxy pool is not Mihomo managed" }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const hasNode = text(body?.nodeName);
    const result = hasNode
      ? await probeMihomoNodeEgress({
        poolId: id,
        proxyProvider: requiredText(body.proxyProvider || "__selector__", "proxyProvider"),
        nodeName: requiredText(body.nodeName, "nodeName"),
      })
      : await probeMihomoNodesEgress({
        poolId: id,
        region: text(body?.region) || null,
        proxyProvider: text(body?.proxyProvider) || null,
        limit: body?.limit,
        force: body?.force === true,
      });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const result = mihomoAdminErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
