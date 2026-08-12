import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

export const DEFAULT_MIHOMO_CONTROLLER = {
  id: "default",
  enabled: false,
  controllerUrl: "",
  secret: "",
  proxyUrl: "",
  selectorName: "",
  providerNames: [],
  syncIntervalMinutes: 5,
  status: {
    lastSyncAt: null,
    lastSyncError: null,
    lastSyncSummary: null,
  },
};

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  mihomoController: DEFAULT_MIHOMO_CONTROLLER,
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  merged.mihomoController = normalizeMihomoController(merged.mihomoController);
  return merged;
}

function normalizeMihomoController(raw) {
  const value = raw?.config && typeof raw.config === "object"
    ? { ...raw.config, status: raw.status || raw.config.status }
    : (raw || {});
  const status = value.status && typeof value.status === "object" ? value.status : {};
  const providerNames = Array.isArray(value.providerNames)
    ? [...new Set(value.providerNames.map((name) => typeof name === "string" ? name.trim() : "").filter(Boolean))]
    : [];
  const interval = Number(value.syncIntervalMinutes);

  return {
    ...DEFAULT_MIHOMO_CONTROLLER,
    ...value,
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : DEFAULT_MIHOMO_CONTROLLER.id,
    enabled: value.enabled === true,
    controllerUrl: typeof value.controllerUrl === "string" ? value.controllerUrl.trim() : "",
    secret: typeof value.secret === "string" ? value.secret : "",
    proxyUrl: typeof value.proxyUrl === "string" ? value.proxyUrl.trim() : "",
    selectorName: typeof value.selectorName === "string" ? value.selectorName.trim() : "",
    providerNames,
    syncIntervalMinutes: Number.isInteger(interval) && interval >= 1 && interval <= 1440 ? interval : 5,
    status: {
      ...DEFAULT_MIHOMO_CONTROLLER.status,
      ...status,
    },
  };
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

export function sanitizeMihomoControllerConfig(config) {
  const normalized = normalizeMihomoController(config);
  const { secret, status, ...safeConfig } = normalized;
  return {
    ...safeConfig,
    secretConfigured: Boolean(secret),
  };
}

export function getMihomoControllerStatus(config) {
  return { ...normalizeMihomoController(config).status };
}

export async function getMihomoControllerConfig() {
  const settings = await getSettings();
  return settings.mihomoController;
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  if (updates && Object.prototype.hasOwnProperty.call(updates, "mihomoController")) {
    const error = new Error("mihomoController must be changed through its dedicated API");
    error.code = "MIHOMO_SETTINGS_PROTECTED";
    throw error;
  }
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function updateMihomoControllerConfig(updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new Error("Invalid Mihomo Controller configuration");
  }
  const db = await getAdapter();
  let nextConfig;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const currentRaw = row ? parseJson(row.data, {}) : {};
    const current = normalizeMihomoController(currentRaw.mihomoController);
    nextConfig = normalizeMihomoController({ ...current, ...updates });
    const nextRaw = { ...currentRaw, mihomoController: nextConfig };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(nextRaw)],
    );
  });
  return nextConfig;
}

export async function updateMihomoControllerStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Invalid Mihomo Controller status");
  }
  const db = await getAdapter();
  let nextConfig;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const currentRaw = row ? parseJson(row.data, {}) : {};
    const current = normalizeMihomoController(currentRaw.mihomoController);
    nextConfig = normalizeMihomoController({
      ...current,
      status: { ...current.status, ...status },
    });
    const nextRaw = { ...currentRaw, mihomoController: nextConfig };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(nextRaw)],
    );
  });
  return nextConfig.status;
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
