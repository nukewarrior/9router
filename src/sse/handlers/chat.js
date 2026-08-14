import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getProxyPoolById } from "@/models";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse, mihomoUnavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import {
  prepareMihomoRouteAttempt,
  withMihomoSelectorLease,
} from "@/lib/network/mihomoRouteManager.js";
import {
  markMihomoNodeEgressNeedsProbe,
  recordMihomoNodeTransportFailure,
  recordMihomoNodeTransportSuccess,
  recordMihomoRouteFailure,
  recordMihomoRouteSuccess,
} from "@/lib/network/mihomoState.js";
import { rebuildHealthyMihomoSnapshot } from "@/lib/network/mihomoHealthPool.js";
import { classifyRateLimitError, isIpCandidateRateLimitError } from "open-sse/services/errorClassification.js";
import {
  createMihomoDebugContext,
  createMihomoDebugId,
  mihomoDebug,
  mihomoErrorFields,
  resolveMihomoRequestId,
} from "open-sse/utils/mihomoDebug.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

async function executeChatCoreAttempt({
  body,
  provider,
  model,
  credentials,
  clientRawRequest,
  request,
  apiKey,
  userAgent,
  proxyOptionsOverride = null,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const chatSettings = await getSettings();
  const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
  return handleChatCore({
    body: { ...body, model: `${provider}/${model}` },
    modelInfo: { provider, model },
    credentials,
    log,
    clientRawRequest,
    connectionId: credentials.connectionId || credentials.id || "noauth",
    userAgent,
    apiKey,
    ccFilterNaming: !!chatSettings.ccFilterNaming,
    rtkEnabled: !!chatSettings.rtkEnabled,
    headroomEnabled: !!chatSettings.headroomEnabled,
    headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
    headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
    cavemanEnabled: !!chatSettings.cavemanEnabled,
    cavemanLevel: chatSettings.cavemanLevel || "full",
    ponytailEnabled: !!chatSettings.ponytailEnabled,
    ponytailLevel: chatSettings.ponytailLevel || "full",
    pxpipeEnabled: !!chatSettings.pxpipeEnabled,
    pxpipeMinChars: chatSettings.pxpipeMinChars,
    pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
    // Lazily warms the in-process module on first use; null when not installed (fail-open)
    pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
    onPxpipeEvent: appendPxpipeEvent,
    providerThinking,
    proxyOptionsOverride,
    // Detect source format by endpoint + body
    sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
    onCredentialsRefreshed,
    onRequestSuccess,
  });
}

function mihomoErrorResponse(error) {
  const code = error?.code || "MIHOMO_ROUTE_FAILED";
  const status = Number(error?.status) || (
    [
      "MIHOMO_MODEL_NOT_MANAGED",
      "MIHOMO_POOL_WARMING",
      "MIHOMO_POOL_SATURATED",
      "MIHOMO_NO_ELIGIBLE_NODES",
      "MIHOMO_POOL_EXHAUSTED",
    ].includes(code)
      ? HTTP_STATUS.SERVICE_UNAVAILABLE
      : code === "MIHOMO_POOL_RATE_LIMITED"
        ? HTTP_STATUS.RATE_LIMITED
        : code === "ABORT_ERR"
          ? 499
          : code === "MIHOMO_INVALID_CONFIG" || code === "MIHOMO_INVALID_STATE_KEY"
            ? HTTP_STATUS.BAD_REQUEST
            : HTTP_STATUS.BAD_GATEWAY
  );
  if ([
    "MIHOMO_MODEL_NOT_MANAGED",
    "MIHOMO_POOL_WARMING",
    "MIHOMO_POOL_SATURATED",
    "MIHOMO_NO_ELIGIBLE_NODES",
    "MIHOMO_POOL_RATE_LIMITED",
    "MIHOMO_POOL_EXHAUSTED",
  ].includes(code)) {
    return mihomoUnavailableResponse(
      status,
      `[${code}] ${error?.message || "Mihomo route is temporarily unavailable"}`,
      error?.retryAfter || null,
    );
  }
  return errorResponse(status, `[${code}] ${error?.message || "Mihomo route failed"}`);
}

function mihomoRouteDebugContext(routeContext, route = null) {
  return createMihomoDebugContext({
    requestId: route?.requestId || routeContext.requestId,
    routeId: route?.routeId || routeContext.routeId,
    attempt: route?.attempt,
    maxAttempts: route?.maxAttempts || routeContext.maxAttempts,
  });
}

function mihomoRouteEgress(route) {
  return route?.egressIdentityKey || route?.egressSnapshot?.identityKey || "unknown";
}

function mihomoLegacyContext(routeContext, route = null) {
  const attempt = Number(route?.attempt);
  const maxAttempts = Number(route?.maxAttempts || routeContext.maxAttempts);
  const attemptText = Number.isFinite(attempt)
    ? ` attempt=${attempt}/${Number.isFinite(maxAttempts) ? maxAttempts : "?"}`
    : "";
  return `req=${routeContext.requestId} route=${routeContext.routeId}${attemptText}`;
}

function isMihomoTransportFailure(result) {
  if (Number(result?.status) !== HTTP_STATUS.BAD_GATEWAY) return false;
  return /(fetch failed|proxy required|und_err_|econn|etimedout|timed out|timeout|socket|connect)/i.test(String(result?.error || ""));
}

function finiteMihomoTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isMihomoNodeTransportCooling(node, nowMs = Date.now()) {
  const cooldownUntil = finiteMihomoTime(node?.transportCooldownUntil);
  if (Number.isFinite(cooldownUntil)) return cooldownUntil > nowMs;
  return node?.transportStatus === "cooling";
}

function releaseMihomoReservation(prepared) {
  try {
    prepared?.reservation?.release?.();
  } catch {
    // Reservation release is idempotent and must not mask the upstream result.
  }
}

function hasMihomoBackupNode(prepared, routeContext, route) {
  if (!prepared?.entry?.nodes) return false;
  const attempted = routeContext.attemptedNodeKeysByEgress.get(prepared.entry.identityKey) || new Set();
  const currentNodeKey = route.nodeKey || `${route.proxyProvider || "__selector__"}\0${route.nodeName}`;
  return prepared.entry.nodes.some((node) => (
    !attempted.has(node.key)
      && node.key !== currentNodeKey
      && !isMihomoNodeTransportCooling(node)
  ));
}

async function rebuildMihomoModelSnapshot({ poolId, modelId, pool = null, getPool = getProxyPoolById, rebuild = rebuildHealthyMihomoSnapshot }) {
  const current = pool || await getPool(poolId);
  if (!current) return null;
  return rebuild({ pool: current, directory: null, modelId, nowMs: Date.now() });
}

export async function executeMihomoNoAuthRoute({
  body,
  provider,
  model,
  credentials,
  clientRawRequest,
  request,
  apiKey,
  userAgent,
  deps = {},
}) {
  const poolId = credentials.providerSpecificData?.connectionProxyPoolId;
  if (!poolId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Mihomo managed routing requires a proxy pool");

  const prepareRoute = deps.prepareRoute || prepareMihomoRouteAttempt;
  const leaseRoute = deps.leaseRoute || withMihomoSelectorLease;
  const recordFailure = deps.recordFailure || recordMihomoRouteFailure;
  const recordSuccess = deps.recordSuccess || recordMihomoRouteSuccess;
  const recordTransportFailure = deps.recordTransportFailure || recordMihomoNodeTransportFailure;
  const recordTransportSuccess = deps.recordTransportSuccess || recordMihomoNodeTransportSuccess;
  const executeAttempt = deps.executeAttempt || executeChatCoreAttempt;
  const getPool = deps.getPool || getProxyPoolById;
  const rebuildSnapshot = deps.rebuildSnapshot || rebuildHealthyMihomoSnapshot;
  const requestStartedAt = Date.now();
  const selectedModelId = model;

  const routeContext = {
    modelId: selectedModelId,
    attemptedEgressKeys: new Set(),
    attemptedNodeKeysByEgress: new Map(),
    attempts: 0,
    requestId: resolveMihomoRequestId({ request, clientRawRequest, body }),
    routeId: createMihomoDebugId(),
  };
  let lastResult = null;
  let lastRoute = null;
  let lastRateLimitUntil = null;

  while (true) {
    let prepared;
    try {
      prepared = await prepareRoute({
        poolId,
        modelId: selectedModelId,
        routeContext,
        getPool,
        signal: request?.signal || null,
      });
    } catch (error) {
      mihomoDebug("prepare.failed", mihomoRouteDebugContext(routeContext), {
        elapsed: Date.now() - requestStartedAt,
        ...mihomoErrorFields(error),
      });
      mihomoDebug("complete", mihomoRouteDebugContext(routeContext), {
        result: "failed",
        attempts: routeContext.attempts,
        finalStatus: HTTP_STATUS.BAD_GATEWAY,
        elapsed: Date.now() - requestStartedAt,
      });
      return mihomoErrorResponse(error);
    }
    if (!prepared.route) break;

    let route = prepared.route;
    lastRoute = route;
    let groupExhausted = false;
    while (true) {
      log.info("MIHOMO", `${mihomoLegacyContext(routeContext, route)} pool=${poolId} selector="${route.selectorName}" attempt=${route.attempt}/${prepared.effectiveMaxAttempts} node="${route.nodeName}"`);
      let result;
      try {
        result = await leaseRoute({
          poolId,
          nodeName: route.nodeName,
          route,
          priority: 0,
          signal: request?.signal || null,
          getPool,
        }, async (proxyOptions) => executeAttempt({
          body,
          provider,
          model,
          credentials,
          clientRawRequest,
          request,
          apiKey,
          userAgent,
          proxyOptionsOverride: proxyOptions,
        }));
      } catch (error) {
        releaseMihomoReservation(prepared);
        mihomoDebug("route.failed", mihomoRouteDebugContext(routeContext, route), {
          phase: "controller",
          elapsed: Date.now() - route.attemptStartedAtMs,
          ...mihomoErrorFields(error),
        });
        return mihomoErrorResponse(error);
      }

      if (result.success) {
        releaseMihomoReservation(prepared);
        try {
          await recordTransportSuccess({
            proxyPoolId: poolId,
            route,
            expectedMappingVersion: route.mappingVersion,
          }).catch(() => {});
          const success = await recordSuccess({
            proxyPoolId: poolId,
            route,
            modelId: selectedModelId,
          });
          await rebuildMihomoModelSnapshot({
            poolId,
            modelId: selectedModelId,
            pool: success?.pool || null,
            getPool,
            rebuild: rebuildSnapshot,
          });
        } catch (error) {
          mihomoDebug("route.success_record_failed", mihomoRouteDebugContext(routeContext, route), {
            ...mihomoErrorFields(error),
          });
          return mihomoErrorResponse(error);
        }
        log.info("MIHOMO", `${mihomoLegacyContext(routeContext, route)} success node="${route.nodeName}"`);
        mihomoDebug("complete", mihomoRouteDebugContext(routeContext, route), {
          result: "success",
          attempts: routeContext.attempts,
          finalNode: route.nodeName,
          finalEgress: mihomoRouteEgress(route),
          elapsed: Date.now() - requestStartedAt,
        });
        return result.response;
      }

      lastResult = result;
      const classification = classifyRateLimitError(result.status, result.error);
      const isTransport = isMihomoTransportFailure(result);
      const isRetryCandidate = isIpCandidateRateLimitError(result.status, result.error);
      mihomoDebug(isTransport ? "transport_failure" : "upstream_failure", mihomoRouteDebugContext(routeContext, route), {
        status: result.status || "unknown",
        node: route.nodeName,
        egress: mihomoRouteEgress(route),
        classification,
        retryable: isTransport || isRetryCandidate,
      });

      if (isTransport) {
        const hasBackup = hasMihomoBackupNode(prepared, routeContext, route);
        // A transport failure ends this start attempt before state mutation or
        // a same-egress backup obtains its own Selector lease.
        releaseMihomoReservation(prepared);
        const transportFailure = await recordTransportFailure({
          proxyPoolId: poolId,
          route,
          errorType: "transport",
          error: result.error,
          expectedMappingVersion: route.mappingVersion,
        }).catch(() => null);
        if (hasBackup) {
          await rebuildMihomoModelSnapshot({
            poolId,
            modelId: selectedModelId,
            pool: transportFailure?.pool || null,
            getPool,
            rebuild: rebuildSnapshot,
          }).catch(() => {});
          routeContext.preferredEgressKey = prepared.entry.identityKey;
          // Re-enter preparation so the backup gets a fresh reservation and
          // a new high-priority Selector lease for the same identity.
          groupExhausted = false;
          break;
        }
        groupExhausted = true;
        routeContext.attemptedEgressKeys.add(prepared.entry.identityKey);
        const probeMarked = await markMihomoNodeEgressNeedsProbe({
          proxyPoolId: poolId,
          route,
          expectedMappingVersion: route.mappingVersion,
        }).catch(() => null);
        await rebuildMihomoModelSnapshot({
          poolId,
          modelId: selectedModelId,
          pool: probeMarked?.pool || transportFailure?.pool || null,
          getPool,
          rebuild: rebuildSnapshot,
        }).catch(() => {});
        break;
      }

      releaseMihomoReservation(prepared);
      if (!isRetryCandidate) {
        // Ordinary HTTP 4xx/5xx is returned as-is and never switches egress.
        return result.response;
      }

      lastResult = { ...result, mihomoRateLimited: true };
      try {
        const failure = await recordFailure({
          proxyPoolId: poolId,
          route,
          modelId: selectedModelId,
          status: result.status,
          error: result.error,
          resetsAtMs: result.resetsAtMs,
        });
        if (!failure.updated) return result.response;
        const cooldownMs = Number(failure.cooldownMs);
        if (Number.isFinite(cooldownMs) && cooldownMs >= 0) {
          const candidateUntil = Date.now() + cooldownMs;
          const currentUntil = finiteMihomoTime(lastRateLimitUntil);
          lastRateLimitUntil = new Date(
            currentUntil === null ? candidateUntil : Math.min(currentUntil, candidateUntil),
          ).toISOString();
        }
        routeContext.attemptedEgressKeys.add(prepared.entry.identityKey);
        await rebuildMihomoModelSnapshot({
          poolId,
          modelId: selectedModelId,
          pool: failure.pool || null,
          getPool,
          rebuild: rebuildSnapshot,
        });
        mihomoDebug("cooldown", mihomoRouteDebugContext(routeContext, route), {
          scope: "model_egress",
          identity: prepared.entry.identityKey,
          duration: Number.isFinite(cooldownMs) ? cooldownMs : null,
          until: lastRateLimitUntil,
          reason: failure.lastErrorType || classification || "rate_limit",
        });
      } catch (error) {
        return mihomoErrorResponse(error);
      }
      break;
    }

    if (groupExhausted) {
      mihomoDebug("decision", mihomoRouteDebugContext(routeContext, route), {
        failureType: "transport_error",
        retryable: true,
        cooldownScope: "node_transport",
        next: "next_egress",
      });
    }
  }

  if (lastResult?.mihomoRateLimited) {
    const lastError = lastResult.error || "rate limited";
    const lastUpstreamStatus = lastResult.status || "unknown";
    const response = mihomoUnavailableResponse(
      HTTP_STATUS.RATE_LIMITED,
      `All eligible Mihomo routes are temporarily rate-limited. Last upstream status: ${lastUpstreamStatus}. Last error: ${lastError}`,
      lastRateLimitUntil,
    );
    mihomoDebug("complete", mihomoRouteDebugContext(routeContext, lastRoute), {
      result: "failed",
      attempts: routeContext.attempts,
      finalStatus: HTTP_STATUS.RATE_LIMITED,
      finalNode: lastRoute?.nodeName || null,
      finalEgress: lastRoute ? mihomoRouteEgress(lastRoute) : null,
      elapsed: Date.now() - requestStartedAt,
    });
    return response;
  }

  const response = errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "All eligible Mihomo routes are temporarily unavailable");
  mihomoDebug("complete", mihomoRouteDebugContext(routeContext, lastRoute), {
    result: "failed",
    attempts: routeContext.attempts,
    finalStatus: HTTP_STATUS.SERVICE_UNAVAILABLE,
    elapsed: Date.now() - requestStartedAt,
  });
  return response;
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (credentials?.configurationError) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, credentials.configurationError);
    }

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    if (credentials.providerSpecificData?.mihomoManaged === true) {
      return executeMihomoNoAuthRoute({
        body,
        provider,
        model,
        credentials,
        clientRawRequest,
        request,
        apiKey,
        userAgent,
      });
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    const result = await executeChatCoreAttempt({
      body,
      provider,
      model,
      credentials: refreshedCredentials,
      clientRawRequest,
      request,
      apiKey,
      userAgent,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
