import { NextResponse } from "next/server";
import {
  getMihomoControllerConfig,
  updateMihomoControllerConfig,
} from "@/lib/localDb";
import {
  configureMihomoSyncScheduler,
  getMihomoControllerView,
  mergeMihomoControllerInput,
  syncMihomoControllerSingleFlight,
  stopMihomoSyncScheduler,
} from "@/shared/services/mihomoProxySync.js";
import {
  MihomoControllerError,
  validateMihomoControllerConfig,
} from "@/lib/network/mihomoController.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

function safeError(error) {
  if (error instanceof MihomoControllerError || error?.safeMessage) {
    return {
      error: error.safeMessage || error.message,
      ...(error.code ? { code: error.code } : {}),
    };
  }
  return { error: "Mihomo Controller operation failed", code: "MIHOMO_OPERATION_FAILED" };
}

async function readBody(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
}

function json(data, init = {}) {
  return NextResponse.json(data, { ...init, headers: { ...RESPONSE_HEADERS, ...(init.headers || {}) } });
}

export async function GET() {
  try {
    const config = await getMihomoControllerConfig();
    return json(getMihomoControllerView(config));
  } catch {
    return json({ error: "Mihomo Controller settings could not be read", code: "MIHOMO_SETTINGS_ERROR" }, { status: 500 });
  }
}

export async function PUT(request) {
  const body = await readBody(request);
  if (!body) return json({ error: "Invalid request body", code: "MIHOMO_INVALID_CONFIG" }, { status: 400 });

  try {
    const existing = await getMihomoControllerConfig();
    const candidate = mergeMihomoControllerInput(body, existing);
    const validated = validateMihomoControllerConfig(candidate);
    const saved = await updateMihomoControllerConfig(validated);

    try {
      const result = await configureMihomoSyncScheduler({
        settings: { mihomoController: saved },
        immediate: true,
      });
      const current = await getMihomoControllerConfig();
      return json({
        ...getMihomoControllerView(current),
        summary: result?.summary || getMihomoControllerView(current).status.lastSyncSummary,
      });
    } catch (error) {
      const current = await getMihomoControllerConfig();
      return json({
        ...getMihomoControllerView(current),
        summary: error?.status?.lastSyncSummary || getMihomoControllerView(current).status.lastSyncSummary,
        ...safeError(error),
      }, { status: 502 });
    }
  } catch (error) {
    const status = error?.code === "MIHOMO_INVALID_CONFIG" ? 400 : 500;
    return json(safeError(error), { status });
  }
}

export async function DELETE() {
  try {
    const existing = await getMihomoControllerConfig();
    await updateMihomoControllerConfig({ ...existing, enabled: false });
    stopMihomoSyncScheduler();
    const result = await syncMihomoControllerSingleFlight({ waitForCurrent: true });
    const current = await getMihomoControllerConfig();
    return json({
      success: true,
      ...getMihomoControllerView(current),
      summary: result.summary,
    });
  } catch (error) {
    return json(safeError(error), { status: 500 });
  }
}
