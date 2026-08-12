import { createHash } from "node:crypto";
import {
  getSettings,
  getMihomoControllerConfig,
  getMihomoControllerStatus,
  sanitizeMihomoControllerConfig,
  updateMihomoControllerStatus,
  syncMihomoProxyPools,
  markMihomoPoolsUnavailable,
} from "@/lib/localDb";
import {
  getMihomoProviderProxies,
  getMihomoProxies,
  getMihomoVersion,
  MihomoControllerError,
  validateMihomoControllerConfig,
} from "@/lib/network/mihomoController.js";

export const DEFAULT_MIHOMO_SYNC_INTERVAL_MINUTES = 5;

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function defaultControllerConfig(existing = null) {
  const config = existing && typeof existing === "object" ? existing : {};
  return {
    id: asText(config.id) || "default",
    enabled: config.enabled === true,
    controllerUrl: asText(config.controllerUrl),
    secret: typeof config.secret === "string" ? config.secret : "",
    proxyUrl: asText(config.proxyUrl),
    selectorName: asText(config.selectorName),
    providerNames: Array.isArray(config.providerNames)
      ? [...new Set(config.providerNames.map(asText).filter(Boolean))]
      : [],
    syncIntervalMinutes: Number.isInteger(Number(config.syncIntervalMinutes))
      ? Number(config.syncIntervalMinutes)
      : DEFAULT_MIHOMO_SYNC_INTERVAL_MINUTES,
    status: config.status && typeof config.status === "object" ? { ...config.status } : undefined,
  };
}

/**
 * Merge an API candidate with the currently stored server-side configuration.
 * An empty secret deliberately means "reuse"; clearSecret is the only way to
 * remove the stored secret.
 */
export function mergeMihomoControllerInput(input, existing = null, { defaultEnabled = null } = {}) {
  const source = input?.config && typeof input.config === "object" ? input.config : (input || {});
  const current = defaultControllerConfig(existing);
  const candidate = { ...current };

  for (const field of ["id", "controllerUrl", "proxyUrl", "selectorName"]) {
    if (hasOwn(source, field)) candidate[field] = source[field];
  }
  if (hasOwn(source, "providerNames")) candidate.providerNames = source.providerNames;
  if (hasOwn(source, "syncIntervalMinutes")) candidate.syncIntervalMinutes = source.syncIntervalMinutes;
  if (hasOwn(source, "enabled")) candidate.enabled = source.enabled === true;
  else if (defaultEnabled !== null && existing === null) candidate.enabled = defaultEnabled === true;

  if (source.clearSecret === true || input?.clearSecret === true) {
    candidate.secret = "";
  } else if (hasOwn(source, "secret") && asText(source.secret)) {
    candidate.secret = String(source.secret).trim();
  }

  delete candidate.clearSecret;
  delete candidate.secretConfigured;
  return candidate;
}

export function buildMihomoPoolId(controllerId, providerName, nodeName) {
  const tuple = [asText(controllerId), asText(providerName), asText(nodeName)].join("\u0000");
  return `mihomo-${createHash("sha256").update(tuple).digest("hex")}`;
}

function objectEntries(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => [asText(item?.name) || String(index), item]);
  }
  return Object.entries(value);
}

function providerNodes(provider) {
  const raw = provider?.proxies ?? provider?.nodes ?? [];
  return objectEntries(raw)
    .map(([key, proxy]) => {
      if (typeof proxy === "string") return { name: proxy, type: null, sourceAlive: null };
      const name = asText(proxy?.name) || asText(key);
      if (!name) return null;
      return {
        name,
        type: asText(proxy?.type) || asText(proxy?.adapter) || null,
        sourceAlive: typeof proxy?.alive === "boolean" ? proxy.alive : null,
      };
    })
    .filter(Boolean);
}

function normalizeProviderMap(raw) {
  if (raw?.providers && typeof raw.providers === "object") return raw.providers;
  return raw && typeof raw === "object" ? raw : {};
}

function normalizeProxyMap(raw) {
  if (raw?.proxies && typeof raw.proxies === "object") return raw.proxies;
  return raw && typeof raw === "object" ? raw : {};
}

function selectorNames(proxyMap) {
  return Object.entries(proxyMap)
    .filter(([, value]) => value?.type === "Selector")
    .map(([name]) => name);
}

/**
 * Build a stable preview from Controller provider and Selector snapshots.
 * Nodes with the same name in multiple selected providers are intentionally
 * excluded because Mihomo's PUT selector endpoint selects by name only.
 */
export function buildMihomoNodePreview({ providers, proxies, providerNames, selectorName }) {
  const providerMap = normalizeProviderMap(providers);
  const proxyMap = normalizeProxyMap(proxies);
  const selectedProviders = Array.isArray(providerNames)
    ? [...new Set(providerNames.map(asText).filter(Boolean))]
    : [];
  const selector = proxyMap?.[selectorName];
  if (!selector || selector.type !== "Selector") {
    throw new MihomoControllerError("MIHOMO_SELECTOR_NOT_FOUND", "Mihomo Selector was not found");
  }
  const selectorAll = new Set(Array.isArray(selector.all) ? selector.all.filter((name) => typeof name === "string") : []);
  const candidatesByName = new Map();
  const excluded = [];

  for (const providerName of selectedProviders) {
    const provider = providerMap?.[providerName];
    if (!provider) {
      throw new MihomoControllerError("MIHOMO_PROVIDER_NOT_FOUND", "Mihomo proxy provider was not found");
    }
    const seenInProvider = new Set();
    for (const node of providerNodes(provider)) {
      if (seenInProvider.has(node.name)) continue;
      seenInProvider.add(node.name);
      if (!selectorAll.has(node.name)) {
        excluded.push({ providerName, nodeName: node.name, reason: "not-in-selector" });
        continue;
      }
      const candidates = candidatesByName.get(node.name) || [];
      candidates.push({
        providerName,
        nodeName: node.name,
        type: node.type,
        sourceAlive: node.sourceAlive,
      });
      candidatesByName.set(node.name, candidates);
    }
  }

  const eligible = [];
  const duplicates = [];
  for (const [nodeName, candidates] of candidatesByName) {
    if (candidates.length > 1) {
      const duplicate = {
        nodeName,
        name: nodeName,
        providerNames: candidates.map((candidate) => candidate.providerName),
      };
      duplicates.push(duplicate);
      for (const candidate of candidates) {
        excluded.push({ ...candidate, reason: "duplicate-node-name" });
      }
      continue;
    }
    eligible.push(candidates[0]);
  }

  return {
    eligible,
    excluded,
    duplicates,
    selectorName,
    selectorNow: typeof selector.now === "string" ? selector.now : null,
  };
}

function safeError(error) {
  if (error instanceof MihomoControllerError) {
    return { code: error.code, message: error.message };
  }
  return { code: "MIHOMO_SYNC_FAILED", message: "Mihomo Controller synchronization failed" };
}

function statusFromConfig(config) {
  return getMihomoControllerStatus(config);
}

export function getMihomoControllerView(config) {
  const normalized = defaultControllerConfig(config);
  return {
    config: sanitizeMihomoControllerConfig(normalized),
    status: statusFromConfig(normalized),
  };
}

export async function testMihomoController(input, existing = null) {
  const candidate = mergeMihomoControllerInput(input, existing, { defaultEnabled: true });
  const config = validateMihomoControllerConfig({ ...candidate, enabled: true }, {
    requireEnabled: true,
    requireSelection: false,
  });
  const [version, providers, proxies] = await Promise.all([
    getMihomoVersion(config),
    getMihomoProviderProxies(config),
    getMihomoProxies(config),
  ]);
  const providerMap = normalizeProviderMap(providers);
  const proxyMap = normalizeProxyMap(proxies);
  const preview = config.selectorName && config.providerNames.length > 0
    ? buildMihomoNodePreview({
      providers: providerMap,
      proxies: proxyMap,
      providerNames: config.providerNames,
      selectorName: config.selectorName,
    })
    : { eligible: [], excluded: [], duplicates: [] };
  const providerDetails = Object.entries(providerMap).map(([name, provider]) => {
    const nodes = providerNodes(provider);
    return {
      name,
      vehicleType: provider?.vehicleType || null,
      nodeCount: nodes.length,
      nodes: nodes.map((node) => ({
        name: node.name,
        type: node.type,
        alive: node.sourceAlive,
      })),
    };
  });
  const selectorDetails = selectorNames(proxyMap).map((name) => ({
    name,
    all: Array.isArray(proxyMap[name]?.all) ? proxyMap[name].all : [],
    now: typeof proxyMap[name]?.now === "string" ? proxyMap[name].now : null,
  }));
  return {
    version,
    providers: providerDetails,
    selectors: selectorDetails,
    preview: {
      eligible: preview.eligible.map((entry) => ({
        providerName: entry.providerName,
        nodeName: entry.nodeName,
        type: entry.type || null,
        alive: entry.sourceAlive,
      })),
      excluded: preview.excluded,
      duplicates: preview.duplicates,
    },
  };
}

async function updateSyncStatus(status) {
  try {
    return await updateMihomoControllerStatus(status);
  } catch {
    return status;
  }
}

export async function syncMihomoController() {
  const config = await getMihomoControllerConfig();
  const startedAt = new Date().toISOString();

  if (config.enabled !== true) {
    const markedUnavailable = await markMihomoPoolsUnavailable(config.id);
    const summary = {
      eligible: 0,
      excluded: 0,
      duplicates: 0,
      eligibleNodes: [],
      excludedNodes: [],
      duplicateNodes: [],
      created: 0,
      updated: 0,
      recovered: 0,
      markedUnavailable,
      unavailable: markedUnavailable,
      disabled: true,
    };
    const status = await updateSyncStatus({
      lastSyncAt: startedAt,
      lastSyncError: null,
      lastSyncSummary: summary,
    });
    return { summary, status, config: sanitizeMihomoControllerConfig(config) };
  }

  let configForRequest;
  try {
    configForRequest = validateMihomoControllerConfig(config, { requireEnabled: true });
    const [providers, proxies] = await Promise.all([
      getMihomoProviderProxies(configForRequest),
      getMihomoProxies(configForRequest),
    ]);
    const preview = buildMihomoNodePreview({
      providers,
      proxies,
      providerNames: configForRequest.providerNames,
      selectorName: configForRequest.selectorName,
    });
    const entries = preview.eligible.map((entry) => ({
      id: buildMihomoPoolId(configForRequest.id, entry.providerName, entry.nodeName),
      providerName: entry.providerName,
      nodeName: entry.nodeName,
      sourceAlive: entry.sourceAlive,
      lastSeenAt: startedAt,
    }));
    const poolSummary = await syncMihomoProxyPools({
      controllerId: configForRequest.id,
      proxyUrl: configForRequest.proxyUrl,
      selectorName: configForRequest.selectorName,
      entries,
      now: startedAt,
    });
    const summary = {
      ...poolSummary,
      eligible: preview.eligible.length,
      excluded: preview.excluded.length,
      duplicates: preview.duplicates.length,
      eligibleNodes: preview.eligible,
      excludedNodes: preview.excluded,
      duplicateNodes: preview.duplicates,
      unavailable: poolSummary.markedUnavailable,
      selectorName: configForRequest.selectorName,
      providerNames: configForRequest.providerNames,
    };
    const status = await updateSyncStatus({
      lastSyncAt: startedAt,
      lastSyncError: null,
      lastSyncSummary: summary,
    });
    return { summary, status, config: sanitizeMihomoControllerConfig(configForRequest) };
  } catch (error) {
    const safe = safeError(error);
    const summary = {
      eligible: 0,
      excluded: 0,
      duplicates: 0,
      eligibleNodes: [],
      excludedNodes: [],
      duplicateNodes: [],
      errorCode: safe.code,
    };
    const status = await updateSyncStatus({
      lastSyncAt: startedAt,
      lastSyncError: safe.message,
      lastSyncSummary: summary,
    });
    throw Object.assign(error instanceof Error ? error : new Error(safe.message), {
      code: safe.code,
      safeMessage: safe.message,
      status,
    });
  }
}

function getSchedulerState() {
  if (!globalThis.__mihomoSyncScheduler) {
    globalThis.__mihomoSyncScheduler = {
      timer: null,
      intervalMs: null,
      inFlight: null,
    };
  }
  return globalThis.__mihomoSyncScheduler;
}

function clearSchedulerTimer() {
  const state = getSchedulerState();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.intervalMs = null;
}

export function stopMihomoSyncScheduler() {
  clearSchedulerTimer();
}

export function syncMihomoControllerSingleFlight({ waitForCurrent = false } = {}) {
  const state = getSchedulerState();
  if (state.inFlight) {
    if (!waitForCurrent) return state.inFlight;
    return state.inFlight
      .catch(() => {})
      .then(() => syncMihomoControllerSingleFlight());
  }
  const promise = syncMihomoController().finally(() => {
    if (state.inFlight === promise) state.inFlight = null;
  });
  state.inFlight = promise;
  return promise;
}

/** Configure the process singleton and optionally perform the immediate sync. */
export async function configureMihomoSyncScheduler({ settings = null, immediate = true } = {}) {
  const currentSettings = settings || await getSettings();
  const config = currentSettings?.mihomoController || await getMihomoControllerConfig();
  if (config?.enabled !== true) {
    clearSchedulerTimer();
    return immediate ? syncMihomoControllerSingleFlight({ waitForCurrent: true }) : null;
  }

  const minutes = Number.isInteger(Number(config.syncIntervalMinutes))
    && Number(config.syncIntervalMinutes) >= 1
    && Number(config.syncIntervalMinutes) <= 1440
    ? Number(config.syncIntervalMinutes)
    : DEFAULT_MIHOMO_SYNC_INTERVAL_MINUTES;
  const intervalMs = minutes * 60 * 1000;
  const state = getSchedulerState();
  if (!state.timer || state.intervalMs !== intervalMs) {
    clearSchedulerTimer();
    state.intervalMs = intervalMs;
    state.timer = setInterval(() => {
      syncMihomoControllerSingleFlight().catch((error) => {
        const safe = safeError(error);
        console.warn(`[Mihomo] scheduled sync failed: ${safe.message}`);
      });
    }, intervalMs);
    if (state.timer.unref) state.timer.unref();
  }
  return immediate ? syncMihomoControllerSingleFlight({ waitForCurrent: true }) : null;
}

export const startMihomoSyncScheduler = configureMihomoSyncScheduler;
export const runMihomoSync = syncMihomoControllerSingleFlight;
