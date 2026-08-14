import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import {
  buildMihomoHealthDto,
  MihomoHealthAdminError,
} from "@/lib/network/mihomoHealthAdmin.js";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    if (!isMihomoProxyPool(pool)) return NextResponse.json({ error: "Proxy pool is not Mihomo managed" }, { status: 400 });
    const modelId = new URL(request.url).searchParams.get("model") || null;
    return NextResponse.json(buildMihomoHealthDto({ pool, modelId }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const known = error instanceof MihomoHealthAdminError;
    return NextResponse.json({
      error: known ? error.message : "Failed to load Mihomo health",
      code: known ? error.code : "MIHOMO_HEALTH_FAILED",
    }, { status: known ? error.status : 500 });
  }
}
