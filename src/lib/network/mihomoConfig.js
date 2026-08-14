import { validateMihomoControllerUrl } from "./mihomoClient.js";

export const DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS = Object.freeze([
  60000,
  180000,
  600000,
  1800000,
]);

export const DEFAULT_MIHOMO_CONFIG = Object.freeze({
  controllerUrl: "",
  controllerSecret: "",
  selectorName: "",
  providerNames: [],
  includeRegex: "",
  excludeRegex: "",
  controllerTimeoutMs: 3000,
  syncTtlMs: 30000,
  inventoryRefreshMs: 300000,
  maxAttemptsPerRequest: 6,
  egressProbeUrl: "https://api.ipify.org",
  egressProbeTimeoutMs: 8000,
  samplesPerNode: 2,
  egressProbeTtlMs: 21600000,
  businessHealthRefreshMs: 900000,
  businessHealthTtlMs: 2700000,
  businessProbeTimeoutMs: 15000,
  admissionWaitMs: 3000,
  maxInFlightStartsPerEgress: 1,
  maintenanceBackoffMs: DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS,
  cooldown: {
    baseMs: 300000,
    multiplier: 3,
    maxMs: 1800000,
  },
});

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function normalizeEgressProbeUrl(value) {
  const raw = text(value) || DEFAULT_MIHOMO_CONFIG.egressProbeUrl;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("egressProbeUrl must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError("egressProbeUrl must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("egressProbeUrl must not include credentials or a fragment");
  }
  return parsed.toString();
}

function validateRegex(value, fieldName) {
  if (!value) return "";
  try {
    // Validate at configuration time so a bad regex cannot break routing.
    const inlineFlags = value.match(/^\(\?([imsu]+)\)/i);
    new RegExp(inlineFlags ? value.slice(inlineFlags[0].length) : value, inlineFlags?.[1] || "");
    return value;
  } catch {
    throw new TypeError(`${fieldName} must be a valid regular expression`);
  }
}

export function normalizeMihomoConfig(input = {}, { validateController = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("mihomo configuration must be an object");
  }

  const controllerUrl = text(input.controllerUrl);
  const selectorName = text(input.selectorName);
  if (!controllerUrl) throw new TypeError("Mihomo controllerUrl is required");
  if (!selectorName) throw new TypeError("Mihomo selectorName is required");
  if (validateController) validateMihomoControllerUrl(controllerUrl);

  const cooldown = input.cooldown && typeof input.cooldown === "object" ? input.cooldown : {};
  const baseMs = boundedInteger(cooldown.baseMs, DEFAULT_MIHOMO_CONFIG.cooldown.baseMs, 1000, 86400000);
  const maxMs = boundedInteger(cooldown.maxMs, DEFAULT_MIHOMO_CONFIG.cooldown.maxMs, baseMs, 604800000);
  const businessHealthRefreshMs = boundedInteger(
    input.businessHealthRefreshMs,
    DEFAULT_MIHOMO_CONFIG.businessHealthRefreshMs,
    60000,
    21600000,
  );

  return {
    controllerUrl,
    controllerSecret: text(input.controllerSecret),
    selectorName,
    providerNames: stringList(input.providerNames),
    includeRegex: validateRegex(text(input.includeRegex), "includeRegex"),
    excludeRegex: validateRegex(text(input.excludeRegex), "excludeRegex"),
    controllerTimeoutMs: boundedInteger(input.controllerTimeoutMs, DEFAULT_MIHOMO_CONFIG.controllerTimeoutMs, 100, 30000),
    syncTtlMs: boundedInteger(input.syncTtlMs, DEFAULT_MIHOMO_CONFIG.syncTtlMs, 1000, 600000),
    inventoryRefreshMs: boundedInteger(input.inventoryRefreshMs, DEFAULT_MIHOMO_CONFIG.inventoryRefreshMs, 60000, 3600000),
    maxAttemptsPerRequest: boundedInteger(input.maxAttemptsPerRequest, DEFAULT_MIHOMO_CONFIG.maxAttemptsPerRequest, 1, 50),
    egressProbeUrl: normalizeEgressProbeUrl(input.egressProbeUrl),
    egressProbeTimeoutMs: boundedInteger(input.egressProbeTimeoutMs, DEFAULT_MIHOMO_CONFIG.egressProbeTimeoutMs, 1000, 30000),
    samplesPerNode: boundedInteger(input.samplesPerNode, DEFAULT_MIHOMO_CONFIG.samplesPerNode, 2, 5),
    egressProbeTtlMs: boundedInteger(input.egressProbeTtlMs, DEFAULT_MIHOMO_CONFIG.egressProbeTtlMs, 300000, 86400000),
    businessHealthRefreshMs,
    businessHealthTtlMs: boundedInteger(
      input.businessHealthTtlMs,
      DEFAULT_MIHOMO_CONFIG.businessHealthTtlMs,
      businessHealthRefreshMs * 2,
      86400000,
    ),
    businessProbeTimeoutMs: boundedInteger(input.businessProbeTimeoutMs, DEFAULT_MIHOMO_CONFIG.businessProbeTimeoutMs, 1000, 60000),
    admissionWaitMs: boundedInteger(input.admissionWaitMs, DEFAULT_MIHOMO_CONFIG.admissionWaitMs, 0, 30000),
    maxInFlightStartsPerEgress: boundedInteger(
      input.maxInFlightStartsPerEgress,
      DEFAULT_MIHOMO_CONFIG.maxInFlightStartsPerEgress,
      1,
      10,
    ),
    maintenanceBackoffMs: [...DEFAULT_MIHOMO_MAINTENANCE_BACKOFF_MS],
    cooldown: {
      baseMs,
      multiplier: boundedNumber(cooldown.multiplier, DEFAULT_MIHOMO_CONFIG.cooldown.multiplier, 1, 10),
      maxMs,
    },
  };
}

export function mergeMihomoConfig(current = {}, updates = {}) {
  const currentCooldown = current?.cooldown && typeof current.cooldown === "object" ? current.cooldown : {};
  const updateCooldown = updates?.cooldown && typeof updates.cooldown === "object" ? updates.cooldown : {};
  return normalizeMihomoConfig({
    ...current,
    ...updates,
    cooldown: { ...currentCooldown, ...updateCooldown },
  });
}

export function createEmptyMihomoState() {
  return {
    version: 2,
    proxyProviders: {},
    egressIdentities: {},
    maintenance: {
      cycleId: null,
      status: "idle",
      startedAt: null,
      completedAt: null,
      nextRunAt: null,
      selectedModels: [],
      nodeCount: 0,
      mappedNodeCount: 0,
      distinctEgressCount: 0,
      totalBusinessChecks: 0,
      completedBusinessChecks: 0,
      healthyByModel: {},
      lastError: null,
    },
  };
}
