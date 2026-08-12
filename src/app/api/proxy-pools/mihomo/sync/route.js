import { NextResponse } from "next/server";
import { getMihomoControllerConfig } from "@/lib/localDb";
import {
  getMihomoControllerView,
  syncMihomoControllerSingleFlight,
} from "@/shared/services/mihomoProxySync.js";
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
  return { error: "Mihomo Controller synchronization failed", code: "MIHOMO_SYNC_FAILED" };
}

export async function POST() {
  try {
    const result = await syncMihomoControllerSingleFlight();
    return NextResponse.json({ summary: result.summary, status: result.status }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    let status = error?.status;
    if (!status || typeof status !== "object") {
      try {
        const config = await getMihomoControllerConfig();
        status = getMihomoControllerView(config).status;
      } catch {
        status = undefined;
      }
    }
    return NextResponse.json({
      ...(status ? { status } : {}),
      ...safeError(error),
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
