import { NextResponse } from "next/server";
import { getMihomoControllerConfig } from "@/lib/localDb";
import { testMihomoController } from "@/shared/services/mihomoProxySync.js";
import { MihomoControllerError } from "@/lib/network/mihomoController.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function safeError(error) {
  if (error instanceof MihomoControllerError || error?.safeMessage) {
    return {
      error: error.safeMessage || error.message,
      ...(error.code ? { code: error.code } : {}),
    };
  }
  return { error: "Mihomo Controller test failed", code: "MIHOMO_TEST_FAILED" };
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "MIHOMO_INVALID_CONFIG" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", code: "MIHOMO_INVALID_CONFIG" }, { status: 400 });
  }

  try {
    const existing = await getMihomoControllerConfig();
    const result = await testMihomoController(body, existing);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error?.code === "MIHOMO_INVALID_CONFIG" || error?.code === "MIHOMO_SELECTION_INVALID"
      ? 400
      : 502;
    return NextResponse.json(safeError(error), { status });
  }
}
