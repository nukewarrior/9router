import { isIP } from "node:net";
import { getProxyPoolById } from "@/models";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { withMihomoSelectorLease } from "./mihomoRouteManager.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";
import { createMihomoClient } from "./mihomoClient.js";
import {
  attachMihomoNodeEgress,
  discoverMihomoNodeDirectory,
  getMihomoNodeEgress,
  isMihomoEgressFresh,
  recordMihomoNodeEgress,
} from "./mihomoState.js";
import {
  enqueueMihomoEgressBatch,
  getMihomoEgressProbeReason,
} from "./mihomoEgressScheduler.js";
import { MIHOMO_MAINTENANCE_PRIORITY } from "./mihomoMaintenanceScheduler.js";

const MAX_OBSERVED_IPS = 5;

const PUBLIC_EGRESS_FIELDS = [
  "ip",
  "family",
  "identityKey",
  "confidence",
  "observedIps",
  "sampleCount",
  "successfulSamples",
  "observedAt",
  "expiresAt",
  "lastProbeAt",
  "lastProbeError",
  "needsProbe",
];

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function formatError(error) {
  return text(error?.message || error) || "Egress probe failed";
}

function redactSensitiveText(value) {
  return text(value)
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]+@/giu, "$1")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[redacted]");
}

function pickPublicFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => [field, value[field]]));
}

function publicEgress(egress) {
  const picked = pickPublicFields(egress, PUBLIC_EGRESS_FIELDS);
  if (!picked) return null;
  if (Array.isArray(picked.observedIps)) picked.observedIps = picked.observedIps.map((ip) => redactSensitiveText(ip));
  if (picked.lastProbeError) picked.lastProbeError = redactSensitiveText(picked.lastProbeError);
  return picked;
}

function publicRoute(route) {
  return pickPublicFields(route, [
    "proxyPoolId",
    "proxyProvider",
    "nodeName",
    "region",
    "selectorName",
    "egressIdentityKey",
    "egressConfidence",
    "attempt",
    "attemptStartedAtMs",
    "routeId",
  ]);
}

function publicDirectory(directory) {
  if (!directory || typeof directory !== "object") return null;
  return {
    selectorName: text(directory.selectorName) || null,
    selectorNow: text(directory.selectorNow) || null,
    warnings: Array.isArray(directory.warnings) ? directory.warnings.map(redactSensitiveText) : [],
    nodes: Array.isArray(directory.nodes) ? directory.nodes.map((node) => ({
      key: text(node?.key) || null,
      nodeName: text(node?.nodeName) || null,
      proxyProvider: text(node?.proxyProvider) || null,
      region: text(node?.region) || "OTHER",
      type: text(node?.type) || null,
      alive: node?.alive === true ? true : node?.alive === false ? false : null,
      delayMs: Number.isFinite(Number(node?.delayMs)) ? Number(node.delayMs) : null,
      egress: publicEgress(node?.egress),
    })) : [],
  };
}

function publicProbeResult(result) {
  return {
    ok: result?.ok === true,
    route: publicRoute(result?.route),
    egress: publicEgress(result?.egress),
    samples: Array.isArray(result?.samples)
      ? result.samples.map((sample) => normalizeEgressIdentity(sample)?.ip || redactSensitiveText(sample)).filter(Boolean)
      : [],
    errors: Array.isArray(result?.errors) ? result.errors.map(redactSensitiveText) : [],
  };
}

/**
 * Serialize egress probe output for HTTP callers. Probe services retain the
 * internal pool for persistence and follow-up work, but it must never cross
 * the API boundary because it contains Mihomo credentials and runtime state.
 */
export function toPublicMihomoEgressProbeResponse(result) {
  if (Array.isArray(result?.results)) {
    return {
      ok: result.ok === true,
      region: text(result.region) || null,
      requested: Math.max(0, Number(result.requested) || 0),
      queued: Math.max(0, Number(result.queued) || 0),
      skipped: Math.max(0, Number(result.skipped) || 0),
      results: result.results.map(publicProbeResult),
      directory: publicDirectory(result.directory),
      summary: pickPublicFields(result.summary, [
        "leafNodes",
        "probedNodes",
        "freshStableMappings",
        "distinctExitIps",
        "duplicateNodes",
        "dynamicNodes",
        "tentativeNodes",
        "unknownNodes",
        "staleNodes",
      ]),
    };
  }
  return publicProbeResult(result);
}

function parseIpv4(ip) {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.join(".");
}

function parseIpv6Groups(ip) {
  let value = ip.toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.includes("%")) return null;

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parsePart = (part) => {
    if (!part) return [];
    const pieces = part.split(":");
    const groups = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const ipv4 = parseIpv4(piece);
        if (!ipv4) return null;
        const octets = ipv4.split(".").map(Number);
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const left = parsePart(halves[0]);
  const right = parsePart(halves[1] || "");
  if (!left || !right) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function canonicalizeIpv6(ip) {
  const groups = parseIpv6Groups(ip);
  if (!groups || groups.length !== 8) return null;

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }

  const formatGroup = (group) => group.toString(16);
  if (bestStart < 0) return groups.map(formatGroup).join(":");
  const left = groups.slice(0, bestStart).map(formatGroup).join(":");
  const right = groups.slice(bestStart + bestLength).map(formatGroup).join(":");
  if (!left && !right) return "::";
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

/**
 * Convert a probe response into the stable identity used by routing state.
 * Invalid values return null so a bad/HTML response is never persisted as an
 * egress identity.
 */
export function normalizeEgressIdentity(value) {
  let ip = text(value);
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1).trim();
  if (!ip || /\s/.test(ip)) return null;

  const family = isIP(ip);
  if (family === 4) {
    const canonical = parseIpv4(ip);
    return canonical ? { ip: canonical, family: 4, identityKey: `4:${canonical}` } : null;
  }
  if (family === 6) {
    const canonical = canonicalizeIpv6(ip);
    return canonical ? { ip: canonical, family: 6, identityKey: `6:${canonical}` } : null;
  }
  return null;
}

function sampleIdentity(sample) {
  if (typeof sample === "string") return normalizeEgressIdentity(sample);
  if (sample && typeof sample === "object") {
    if (sample.identityKey && sample.ip) return normalizeEgressIdentity(sample.ip);
    return normalizeEgressIdentity(sample.ip || sample.body || sample.value);
  }
  return null;
}

/**
 * Derive a bounded mapping from one node's samples. Mapping freshness is kept
 * separate from confidence: an expired stable mapping is still stable, but is
 * no longer eligible for egress-aware routing.
 */
export function evaluateEgressProbeSamples(samples = [], {
  errors = [],
  nowMs = Date.now(),
  ttlMs = 21600000,
} = {}) {
  const attempted = Array.isArray(samples) ? samples : [];
  const successful = attempted.map(sampleIdentity).filter(Boolean);
  const unique = [...new Map(successful.map((identity) => [identity.identityKey, identity])).values()];
  const normalizedErrors = (Array.isArray(errors) ? errors : [errors]).map(formatError).filter(Boolean);
  const observedAt = successful.length > 0 ? nowMs : null;
  const expiresAt = observedAt === null ? null : nowMs + Math.max(0, Number(ttlMs) || 0);

  let confidence = "unknown";
  if (unique.length > 1) confidence = "dynamic";
  else if (successful.length >= 2) confidence = "stable";
  else if (successful.length === 1) confidence = "tentative";

  const primary = confidence === "stable" || confidence === "tentative" ? successful[0] : null;
  return {
    ip: primary?.ip || null,
    family: primary?.family || null,
    identityKey: primary?.identityKey || null,
    confidence,
    observedIps: unique.map((identity) => identity.ip).slice(0, MAX_OBSERVED_IPS),
    sampleCount: Math.max(attempted.length, normalizedErrors.length),
    successfulSamples: successful.length,
    observedAt,
    expiresAt,
    lastProbeAt: nowMs,
    lastProbeError: normalizedErrors.at(-1) || (confidence === "unknown" ? "No valid egress sample" : null),
    needsProbe: confidence === "unknown" || normalizedErrors.length > 0,
  };
}

function createAbortSignal(timeoutMs, parentSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8000));
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  return { signal, timer };
}

async function fetchProbeSample({
  url,
  proxyOptions,
  timeoutMs,
  fetchProbe,
  signal = null,
}) {
  const { signal: requestSignal, timer } = createAbortSignal(timeoutMs, signal);
  try {
    const response = await fetchProbe(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "text/plain",
        "User-Agent": "9Router-Mihomo-Egress-Discovery",
      },
      signal: requestSignal,
    }, {
      ...proxyOptions,
      strictProxy: true,
      ephemeralProxyDispatcher: true,
      connectionNoProxy: "",
    });
    if (!response?.ok) {
      throw new Error(`Egress probe returned HTTP ${response?.status || "unknown"}`);
    }
    const body = await response.text();
    const identity = normalizeEgressIdentity(body);
    if (!identity) throw new Error("Egress probe returned an invalid IP address");
    return identity.ip;
  } finally {
    clearTimeout(timer);
  }
}

async function loadPool(poolId, getPool) {
  const pool = await getPool(poolId);
  if (!pool) throw new Error("Mihomo proxy pool was not found");
  return pool;
}

/**
 * Probe one node while holding the exact same Selector lease used by a live
 * request. Every sample is a fresh CONNECT through the managed listener.
 */
export async function probeMihomoNodeEgress({
  poolId,
  proxyProvider,
  nodeName,
  getPool = getProxyPoolById,
  makeClient,
  fetchProbe = proxyAwareFetch,
  mutatePool,
  nowMs = Date.now(),
  selectorLeasePriority = 20,
  signal = null,
  expectedMappingVersion = null,
  probeStartedAtMs = nowMs,
} = {}) {
  const pool = await loadPool(poolId, getPool);
  const config = normalizeMihomoConfig(pool.mihomo || {});
  const route = { proxyProvider, nodeName };
  const samples = [];
  const errors = [];

  try {
    await withMihomoSelectorLease({
      poolId,
      nodeName,
      route,
      getPool,
      priority: selectorLeasePriority,
      signal,
      ...(makeClient ? { makeClient } : {}),
    }, async (proxyOptions) => {
      for (let index = 0; index < config.samplesPerNode; index += 1) {
        try {
          samples.push(await fetchProbeSample({
            url: config.egressProbeUrl,
            proxyOptions,
            timeoutMs: config.egressProbeTimeoutMs,
            fetchProbe,
            signal,
          }));
        } catch (error) {
          errors.push(formatError(error?.name === "AbortError" ? new Error("Egress probe timed out") : error));
        }
      }
    });
  } catch (error) {
    errors.push(formatError(error));
  }

  const egress = evaluateEgressProbeSamples(samples, {
    errors,
    nowMs,
    ttlMs: config.egressProbeTtlMs,
  });
  const persisted = await recordMihomoNodeEgress({
    proxyPoolId: poolId,
    route,
    egress,
    mutatePool,
    nowMs,
    expectedMappingVersion,
    probeStartedAtMs,
  });
  return {
    ok: egress.successfulSamples > 0,
    stale: persisted.stale === true,
    route,
    egress,
    samples,
    errors,
    pool: persisted.pool || pool,
  };
}

function probeRank(node, nowMs) {
  const egress = node?.egress;
  if (egress?.needsProbe === true) return 0;
  if (!egress || egress.confidence === "unknown") return 0;
  if (!isMihomoEgressFresh(egress, nowMs)) return 1;
  if (egress.lastProbeError) return 2;
  if (egress.confidence === "tentative") return 3;
  return 4;
}

function nodeAge(node) {
  const observedAt = Number(node?.egress?.observedAt);
  return Number.isFinite(observedAt) ? observedAt : Number.MAX_SAFE_INTEGER;
}

export function summarizeMihomoEgressInventory(nodes = [], nowMs = Date.now()) {
  const stableFresh = nodes.filter((node) => node?.egress?.confidence === "stable" && isMihomoEgressFresh(node.egress, nowMs));
  const identityKeys = new Set(stableFresh.map((node) => node.egress.identityKey).filter(Boolean));
  const groupSizes = new Map();
  for (const node of stableFresh) {
    groupSizes.set(node.egress.identityKey, (groupSizes.get(node.egress.identityKey) || 0) + 1);
  }
  return {
    leafNodes: nodes.length,
    probedNodes: nodes.filter((node) => Number(node?.egress?.sampleCount) > 0 || node?.egress?.lastProbeAt).length,
    freshStableMappings: stableFresh.length,
    distinctExitIps: identityKeys.size,
    duplicateNodes: [...groupSizes.values()].filter((size) => size > 1).reduce((sum, size) => sum + size, 0),
    dynamicNodes: nodes.filter((node) => node?.egress?.confidence === "dynamic").length,
    tentativeNodes: nodes.filter((node) => node?.egress?.confidence === "tentative").length,
    unknownNodes: nodes.filter((node) => !node?.egress || node.egress.confidence === "unknown").length,
    staleNodes: nodes.filter((node) => node?.egress && !isMihomoEgressFresh(node.egress, nowMs)).length,
  };
}

/**
 * Probe a bounded set of nodes. Nodes are selected by mapping quality first;
 * each call to the single-node helper obtains its own Selector lease.
 */
export async function probeMihomoNodesEgress({
  poolId,
  region = null,
  proxyProvider = null,
  nodeName = null,
  limit = null,
  force = false,
  queueOnly = false,
  queueProbe = enqueueMihomoEgressBatch,
  getPool = getProxyPoolById,
  makeClient,
  fetchProbe = proxyAwareFetch,
  mutatePool,
  nowMs = Date.now(),
} = {}) {
  let pool = await loadPool(poolId, getPool);
  const config = normalizeMihomoConfig(pool.mihomo || {});
  const clientFactory = makeClient || createMihomoClient;
  const client = clientFactory({
    controllerUrl: config.controllerUrl,
    secret: config.controllerSecret,
    timeoutMs: config.controllerTimeoutMs,
  });

  const directory = await discoverMihomoNodeDirectory({
    poolId: `${poolId}\0egress-inventory`,
    client,
    selectorName: config.selectorName,
    providerNames: config.providerNames,
    includeRegex: config.includeRegex,
    excludeRegex: config.excludeRegex,
    mihomoState: pool.mihomoState,
    ttlMs: config.syncTtlMs,
    nowMs,
  });
  const candidates = directory.nodes
    .filter((node) => !region || node.region === region)
    .filter((node) => !proxyProvider || node.proxyProvider === proxyProvider)
    .filter((node) => !nodeName || node.nodeName === nodeName)
    .filter((node) => force || Boolean(getMihomoEgressProbeReason(node.egress, { nowMs, ttlMs: config.egressProbeTtlMs })) || Boolean(node.egress?.lastProbeError))
    .sort((a, b) => probeRank(a, nowMs) - probeRank(b, nowMs) || nodeAge(a) - nodeAge(b) || a.key.localeCompare(b.key));
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : candidates.length;
  const selected = candidates.slice(0, boundedLimit);
  const results = [];

  if (queueOnly) {
    const queued = await queueProbe({
      poolId,
      nodes: selected.map((node) => ({
        poolId,
        proxyProvider: node.proxyProvider,
        nodeName: node.nodeName,
        egress: node.egress,
        expectedMappingVersion: Math.max(0, Math.floor(Number(node.egress?.mappingVersion) || 0)),
        reason: force
          ? "manual"
          : getMihomoEgressProbeReason(node.egress, { nowMs, ttlMs: config.egressProbeTtlMs }) || "manual",
      })),
      getPool,
      makeClient,
      fetchProbe,
      mutatePool,
      ttlMs: config.egressProbeTtlMs,
      priority: MIHOMO_MAINTENANCE_PRIORITY.manual,
    });
    const refreshedDirectory = attachMihomoNodeEgress(directory, pool);
    return {
      ok: true,
      region: region || null,
      requested: selected.length,
      queued: Number(queued?.queued) || 0,
      skipped: Number(queued?.skipped) || 0,
      results,
      directory: refreshedDirectory,
      summary: summarizeMihomoEgressInventory(refreshedDirectory.nodes, nowMs),
      pool,
    };
  }

  for (const node of selected) {
    const result = await probeMihomoNodeEgress({
      poolId,
      proxyProvider: node.proxyProvider,
      nodeName: node.nodeName,
      getPool,
      makeClient,
      fetchProbe,
      mutatePool,
      nowMs,
      expectedMappingVersion: Math.max(0, Math.floor(Number(node.egress?.mappingVersion) || 0)),
      probeStartedAtMs: nowMs,
    });
    results.push(result);
    pool = result.pool || pool;
  }

  const refreshedDirectory = attachMihomoNodeEgress(directory, pool);
  return {
    ok: true,
    region: region || null,
    requested: selected.length,
    results,
    directory: refreshedDirectory,
    summary: summarizeMihomoEgressInventory(refreshedDirectory.nodes, nowMs),
    pool,
  };
}
