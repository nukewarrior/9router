import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { getMihomoNodeStatus, mihomoAdminErrorResponse } from "@/lib/network/mihomoAdmin.js";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    if (!isMihomoProxyPool(pool)) return NextResponse.json({ error: "Proxy pool is not Mihomo managed" }, { status: 400 });

    const businessProvider = new URL(request.url).searchParams.get("businessProvider") || "opencode";
    return NextResponse.json(await getMihomoNodeStatus({ pool, businessProvider }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const result = mihomoAdminErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
