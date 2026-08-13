import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testMihomoPool, mihomoAdminErrorResponse } from "@/lib/network/mihomoAdmin.js";
import { isMihomoProxyPool } from "@/lib/network/proxyPoolTypes.js";

export async function POST(request, { params }) {
  let pool;
  try {
    const { id } = await params;
    pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    if (!isMihomoProxyPool(pool)) return NextResponse.json({ error: "Proxy pool is not Mihomo managed" }, { status: 400 });

    let body = {};
    try { body = await request.json(); } catch { /* empty body tests the saved config */ }
    const result = await testMihomoPool({ pool, configOverride: body?.mihomo || body });
    const now = new Date().toISOString();
    await updateProxyPool(id, {
      testStatus: "active",
      lastTestedAt: now,
      lastError: null,
      isActive: true,
    });
    return NextResponse.json({ ...result, testedAt: now });
  } catch (error) {
    const result = mihomoAdminErrorResponse(error);
    if (pool?.id) {
      await updateProxyPool(pool.id, {
        testStatus: "error",
        lastTestedAt: new Date().toISOString(),
        lastError: result.body.error,
        isActive: false,
      }).catch(() => {});
    }
    return NextResponse.json(result.body, { status: result.status });
  }
}
