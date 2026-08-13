import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { clearMihomoEgressCooldown } from "@/lib/network/mihomoState.js";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";

function requiredText(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    const error = new Error(`${fieldName} is required`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    if (!isMihomoProxyPool(pool)) return NextResponse.json({ error: "Proxy pool is not Mihomo managed" }, { status: 400 });

    const body = await request.json();
    const identityKey = requiredText(body?.identityKey, "identityKey");
    const businessProvider = requiredText(body?.businessProvider, "businessProvider");
    const result = await clearMihomoEgressCooldown({
      proxyPoolId: id,
      identityKey,
      businessProviderId: businessProvider,
    });
    return NextResponse.json({ ok: result.updated, identityKey, businessProvider });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to clear egress cooldown" }, { status: error.status || 400 });
  }
}
