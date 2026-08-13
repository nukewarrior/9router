import { NextResponse } from "next/server";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";
import { testMihomoPool, mihomoAdminErrorResponse } from "@/lib/network/mihomoAdmin.js";

function bodyPool(body = {}) {
  return {
    id: `mihomo-test-${Date.now()}`,
    type: "mihomo",
    isActive: true,
    proxyUrl: typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : "",
    mihomo: body.mihomo && typeof body.mihomo === "object" ? body.mihomo : {},
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const pool = bodyPool(body);
    if (!isMihomoProxyPool(pool)) {
      return NextResponse.json({ error: "Mihomo pool is required" }, { status: 400 });
    }
    const result = await testMihomoPool({ pool });
    return NextResponse.json(result);
  } catch (error) {
    const result = mihomoAdminErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
