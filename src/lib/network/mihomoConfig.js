import { validateMihomoControllerUrl } from "./mihomoClient.js";

export const DEFAULT_MIHOMO_REGION_ORDER = ["TW", "JP", "US", "SG", "HK", "OTHER"];

export const DEFAULT_MIHOMO_CONFIG = Object.freeze({
  controllerUrl: "",
  controllerSecret: "",
  selectorName: "",
  providerNames: [],
  includeRegex: "",
  excludeRegex: "",
  controllerTimeoutMs: 3000,
  syncTtlMs: 30000,
  maxAttemptsPerRequest: 6,
  regionOrder: DEFAULT_MIHOMO_REGION_ORDER,
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

function regionList(value) {
  const regions = stringList(value);
  return regions.length > 0 ? regions : [...DEFAULT_MIHOMO_REGION_ORDER];
}

function validateRegex(value, fieldName) {
  if (!value) return "";
  try {
    // Validate at configuration time so a bad regex cannot break routing.
    new RegExp(value);
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

  return {
    controllerUrl,
    controllerSecret: text(input.controllerSecret),
    selectorName,
    providerNames: stringList(input.providerNames),
    includeRegex: validateRegex(text(input.includeRegex), "includeRegex"),
    excludeRegex: validateRegex(text(input.excludeRegex), "excludeRegex"),
    controllerTimeoutMs: boundedInteger(input.controllerTimeoutMs, DEFAULT_MIHOMO_CONFIG.controllerTimeoutMs, 100, 30000),
    syncTtlMs: boundedInteger(input.syncTtlMs, DEFAULT_MIHOMO_CONFIG.syncTtlMs, 1000, 600000),
    maxAttemptsPerRequest: boundedInteger(input.maxAttemptsPerRequest, DEFAULT_MIHOMO_CONFIG.maxAttemptsPerRequest, 1, 50),
    regionOrder: regionList(input.regionOrder),
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
  return { proxyProviders: {} };
}
