import { getProxyPoolById, mutateProxyPool } from "@/models";
import { getExecutor } from "open-sse/executors/index.js";
import { isIpCandidateRateLimitError } from "open-sse/services/errorClassification.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { withMihomoSelectorLease } from "./mihomoRouteManager.js";
import {
  getMihomoEgressBusinessState,
  getMihomoModelHealthCooldownMs,
  recordMihomoModelHealthFailure,
  recordMihomoModelHealthSuccess,
} from "./mihomoState.js";
import { normalizeMihomoConfig } from "./mihomoConfig.js";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function truncate(value) {
  return text(value).slice(0, 500);
}

function makeAbortError() {
  const error = new Error("Mihomo business probe timed out");
  error.name = "AbortError";
  error.code = "MIHOMO_BUSINESS_PROBE_TIMEOUT";
  return error;
}

function makeSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(makeAbortError()), Math.max(1, Number(timeoutMs) || 15000));
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  return {
    signal,
    stop() {
      clearTimeout(timer);
    },
  };
}

function header(response, name) {
  if (!response?.headers) return "";
  if (typeof response.headers.get === "function") return text(response.headers.get(name));
  return text(response.headers[name] || response.headers[name.toLowerCase()]);
}

function retryAfterMs(response, nowMs) {
  const value = header(response, "retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > nowMs ? date : null;
}

function bodyMessage(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object") {
    return body.error.message || body.error.code || JSON.stringify(body.error);
  }
  return body.message || body.code || "";
}

function isValidCompletionBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (!Array.isArray(body.choices) || body.choices.length < 1) return false;
  const first = body.choices[0];
  return Boolean(
    first
    && (
      (first.message && typeof first.message === "object")
      || typeof first.text === "string"
      || typeof first.delta === "object"
    ),
  );
}

export function buildMihomoBusinessProbeRequest({ modelId, credentials = {} } = {}) {
  const executor = getExecutor("opencode");
  const body = executor.transformRequest(modelId, {
    model: modelId,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 1,
    stream: false,
  });
  return {
    url: executor.buildUrl(modelId, false, 0, credentials),
    headers: executor.buildHeaders(credentials, false),
    body,
  };
}

export function classifyMihomoBusinessProbeFailure({ status = null, error = "", body = null } = {}) {
  const numericStatus = Number(status);
  const message = truncate(bodyMessage(body) || error);
  if (isIpCandidateRateLimitError(numericStatus, message)) {
    return { category: "rate_limit", status: numericStatus || null, error: message || "OpenCode business rate limit" };
  }
  if (numericStatus === 400 || numericStatus === 404) {
    return { category: "invalid_model", status: numericStatus, error: message || "OpenCode model is invalid" };
  }
  if (numericStatus === 401 || numericStatus === 403) {
    return { category: "configuration", status: numericStatus, error: message || "OpenCode probe authentication failed" };
  }
  if (numericStatus >= 500 && numericStatus <= 599) {
    return { category: "provider_failure", status: numericStatus, error: message || "OpenCode provider failure" };
  }
  return { category: "invalid_response", status: numericStatus || null, error: message || "OpenCode probe returned an invalid response" };
}

function isTransportFailure(error) {
  return /(fetch failed|proxy required|und_err_|econn|etimedout|timed out|timeout|socket|connect)/i.test(
    text(error?.message || error),
  );
}

function routeForNode({ poolId, modelId, entry, node, startedAtMs, requestId }) {
  return {
    requestId,
    routeId: requestId,
    proxyPoolId: poolId,
    modelId,
    identityKey: entry.identityKey,
    egressIdentityKey: entry.identityKey,
    egressSnapshot: {
      identityKey: entry.identityKey,
      confidence: "stable",
      expiresAt: entry.expiresAt,
      evidenceVersion: entry.evidenceVersion,
      scopeEligible: true,
      startedAtMs,
    },
    attempt: 1,
    attemptStartedAtMs: startedAtMs,
    nodeKey: node.key,
    proxyProvider: node.proxyProvider,
    nodeName: node.nodeName,
    mappingVersion: node.mappingVersion,
  };
}

async function readResponseBody(response) {
  try {
    return await response.text();
  } catch (error) {
    throw new Error("OpenCode probe response body could not be read", { cause: error });
  }
}

async function persistResult({
  result,
  poolId,
  modelId,
  entry,
  route,
  getPool,
  mutatePool: mutate,
  nowMs,
  probeStartedAtMs,
}) {
  if (!mutate) return null;
  if (result.ok) {
    return recordMihomoModelHealthSuccess({
      proxyPoolId: poolId,
      identityKey: entry.identityKey,
      modelId,
      source: "probe",
      evidenceStartedAtMs: probeStartedAtMs,
      mutatePool: mutate,
      nowMs,
    });
  }
  if (result.category === "transport") return null;

  const pool = await getPool(poolId);
  const config = normalizeMihomoConfig(pool?.mihomo || {});
  const previous = getMihomoEgressBusinessState(pool, entry.identityKey, modelId);
  const cooldownUntil = result.category === "rate_limit" ? result.resetsAtMs : null;
  const cooldownMs = result.category === "rate_limit"
    ? getMihomoModelHealthCooldownMs(config, previous, cooldownUntil, nowMs)
    : 0;
  const stateStatus = result.category === "rate_limit"
    ? "cooling"
    : result.category === "invalid_model"
      ? "invalid"
      : "refreshing";
  return recordMihomoModelHealthFailure({
    proxyPoolId: poolId,
    identityKey: entry.identityKey,
    modelId,
    status: result.status,
    error: result.error,
    errorType: result.category,
    stateStatus,
    cooldownMs,
    source: "probe",
    evidenceStartedAtMs: probeStartedAtMs,
    mutatePool: mutate,
    nowMs,
  });
}

export async function probeMihomoBusinessEgress({
  poolId,
  modelId,
  entry,
  credentials = {},
  getPool = getProxyPoolById,
  mutatePool: mutate = mutateProxyPool,
  lease = withMihomoSelectorLease,
  fetchRequest = proxyAwareFetch,
  nowMs = Date.now(),
  timeoutMs = 15000,
  signal = null,
  requestId = "mihomo-business-probe",
  persist = true,
  onHealthChanged = null,
} = {}) {
  if (!poolId || !modelId || !entry?.identityKey || !Array.isArray(entry.nodes) || entry.nodes.length === 0) {
    throw new TypeError("poolId, modelId and a non-empty egress entry are required");
  }
  const probeStartedAtMs = nowMs;
  const request = buildMihomoBusinessProbeRequest({ modelId, credentials });
  const timeout = makeSignal(timeoutMs, signal);
  const errors = [];
  let finalResult = null;
  let successfulRoute = null;

  try {
    for (const node of entry.nodes) {
      const route = routeForNode({
        poolId,
        modelId,
        entry,
        node,
        startedAtMs: probeStartedAtMs,
        requestId,
      });
      try {
        const response = await lease({
          poolId,
          nodeName: node.nodeName,
          route,
          priority: 30,
          signal: timeout.signal,
          getPool,
        }, async (proxyOptions) => fetchRequest(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: timeout.signal,
        }, {
          ...proxyOptions,
          strictProxy: true,
          ephemeralProxyDispatcher: true,
          connectionNoProxy: "",
          mihomoManaged: true,
        }));

        const bodyText = await readResponseBody(response);
        let body = null;
        if (bodyText) {
          try {
            body = JSON.parse(bodyText);
          } catch {
            body = null;
          }
        }
        if (!response?.ok) {
          const failure = classifyMihomoBusinessProbeFailure({
            status: response?.status,
            error: bodyMessage(body) || bodyText,
            body,
          });
          finalResult = {
            ok: false,
            ...failure,
            resetsAtMs: failure.category === "rate_limit" ? retryAfterMs(response, nowMs) : null,
            route,
            errors: [...errors, failure.error].filter(Boolean).map(truncate),
          };
          break;
        }
        if (!isValidCompletionBody(body)) {
          finalResult = {
            ok: false,
            category: "invalid_response",
            status: response?.status || null,
            error: "OpenCode probe response did not contain a valid completion",
            route,
            errors: [...errors, "invalid response"].map(truncate),
          };
          break;
        }
        successfulRoute = route;
        finalResult = {
          ok: true,
          category: "success",
          status: response.status,
          route,
          errors,
        };
        break;
      } catch (error) {
        if (signal?.aborted || timeout.signal.aborted && error?.name === "AbortError" && signal?.aborted) {
          finalResult = {
            ok: false,
            category: "aborted",
            status: null,
            error: "OpenCode business probe was aborted",
            route,
            errors: [...errors, "aborted"],
          };
          break;
        }
        if (!isTransportFailure(error)) {
          finalResult = {
            ok: false,
            category: "provider_failure",
            status: null,
            error: truncate(error?.message || error) || "OpenCode business probe failed",
            route,
            errors: [...errors, error?.message || error].map(truncate),
          };
          break;
        }
        errors.push(truncate(error?.message || error) || "transport failure");
        if (entry.nodes[entry.nodes.length - 1] === node) {
          finalResult = {
            ok: false,
            category: "transport",
            status: null,
            error: "All nodes in the Mihomo egress group failed to connect",
            route,
            errors,
            allNodesFailed: true,
          };
        }
      }
    }
  } finally {
    timeout.stop();
  }

  const result = finalResult || {
    ok: false,
    category: "transport",
    status: null,
    error: "Mihomo business probe produced no response",
    errors,
  };
  result.backupRetried = errors.length > 0 && Boolean(successfulRoute);
  result.modelId = modelId;
  result.identityKey = entry.identityKey;
  const persisted = persist
    ? await persistResult({
      result,
      poolId,
      modelId,
      entry,
      route: result.route,
      getPool,
      mutatePool: mutate,
      nowMs,
      probeStartedAtMs,
    })
    : null;
  result.persisted = persisted
    ? {
      updated: persisted.updated === true,
      stale: persisted.stale === true,
      identityKey: entry.identityKey,
      modelId,
    }
    : null;
  await onHealthChanged?.({ result, persisted: result.persisted });
  return result;
}
