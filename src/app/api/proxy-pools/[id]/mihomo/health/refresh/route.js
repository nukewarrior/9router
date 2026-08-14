import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import {
  MihomoHealthAdminError,
  validateMihomoHealthRefresh,
} from "@/lib/network/mihomoHealthAdmin.js";
import { refreshMihomoMaintenance } from "@/lib/network/mihomoMaintenanceService.js";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    const refresh = validateMihomoHealthRefresh({
      pool,
      scope: body?.scope,
      modelId: body?.modelId,
      identityKey: body?.identityKey,
    });
    const result = await refreshMihomoMaintenance(id, refresh);
    return NextResponse.json({
      accepted: result.accepted === true,
      poolId: id,
      reason: "manual",
      deduplicated: result.deduplicated === true,
    }, { status: 202 });
  } catch (error) {
    const known = error instanceof MihomoHealthAdminError;
    return NextResponse.json({
      error: known ? error.message : "Failed to queue Mihomo refresh",
      code: known ? error.code : "MIHOMO_INVALID_REQUEST",
    }, { status: known ? error.status : 500 });
  }
}
