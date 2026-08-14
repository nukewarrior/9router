import { isIP } from "node:net";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_ECHO_URL = "https://api.ipify.org?format=json";
const DEFAULT_TIMEOUT_MS = 10000;

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function listEnv(name) {
  return [...new Set(env(name).split(",").map((item) => item.trim()).filter(Boolean))];
}

function safeError(error, secret = "") {
  let message = error?.message || String(error);
  if (secret) message = message.split(secret).join("[redacted]");
  return message
    .replace(/(Bearer\s+)[^\s,]+/gi, "$1[redacted]")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]+@/giu, "$1");
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function createValidationClient({ controllerUrl, secret, timeoutMs }) {
  const parsed = new URL(controllerUrl);
  assertCondition(parsed.protocol === "http:" || parsed.protocol === "https:", "MIHOMO_CONTROLLER_URL must use http or https");
  assertCondition(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, "MIHOMO_CONTROLLER_URL must not contain credentials, query or fragment");
  const baseUrl = parsed.toString().replace(/\/$/, "");

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await undiciFetch(new URL(path.replace(/^\//, ""), `${baseUrl}/`), {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Controller HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getVersion: () => request("/version"),
    getProxy: (name) => request(`/proxies/${encodeURIComponent(name)}`),
    getProxies: () => request("/proxies"),
    getProxyProvider: (name) => request(`/providers/proxies/${encodeURIComponent(name)}`),
    selectProxy: (selector, node) => request(`/proxies/${encodeURIComponent(selector)}`, { method: "PUT", body: { name: node } }),
    getConnections: () => request("/connections"),
  };
}

function namesFromMetadata(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : item?.name).map((item) => String(item || "").trim()).filter(Boolean);
}

function proxyMapFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  if (payload.proxies && typeof payload.proxies === "object" && !Array.isArray(payload.proxies)) {
    return payload.proxies;
  }
  return payload;
}

async function discoverValidationNodes({ client, selector, providerNames }) {
  const nestedTypes = new Set(["selector", "urltest", "fallback", "loadbalance", "load-balance", "direct", "reject", "dns", "pass"]);
  const proxyMap = proxyMapFromPayload(await client.getProxies());
  const providerNameByNode = new Map();
  for (const providerName of providerNames) {
    const provider = await client.getProxyProvider(providerName);
    for (const nodeName of namesFromMetadata(provider?.proxies || provider?.all)) {
      if (!providerNameByNode.has(nodeName)) providerNameByNode.set(nodeName, providerName);
    }
  }

  const nodes = [];
  for (const nodeName of namesFromMetadata(selector?.all)) {
    const metadata = proxyMap[nodeName] || {};
    const type = String(metadata.type || "").trim().toLowerCase().replace(/\s+/g, "");
    if (nestedTypes.has(type) || metadata.alive === false) continue;
    if (providerNames.length > 0 && !providerNameByNode.has(nodeName)) continue;
    nodes.push({
      nodeName,
      proxyProvider: providerNameByNode.get(nodeName) || "__selector__",
      alive: metadata.alive === true ? true : null,
    });
  }
  return nodes;
}

function extractEchoIp(body) {
  const raw = String(body || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const candidate = typeof parsed === "string" ? parsed : parsed?.ip;
    return isIP(String(candidate || "").trim()) ? String(candidate).trim() : null;
  } catch {
    return isIP(raw) ? raw : null;
  }
}

function redactIp(ip) {
  const value = String(ip || "");
  if (isIP(value) === 4) {
    const parts = value.split(".");
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  if (isIP(value) === 6) return `${value.split(":").slice(0, 3).join(":")}::[redacted]`;
  return "[invalid-ip]";
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function routerRequestHeaders() {
  const headers = { Accept: "application/json" };
  const authorization = env("MIHOMO_ROUTER_AUTHORIZATION");
  const apiKey = env("MIHOMO_ROUTER_API_KEY");
  const cookie = env("MIHOMO_ROUTER_COOKIE");
  if (authorization) headers.Authorization = authorization;
  else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function fetchRouterHealth({ routerUrl, poolId, modelId }) {
  const url = new URL(`/api/proxy-pools/${encodeURIComponent(poolId)}/mihomo/health`, `${routerUrl}/`);
  if (modelId) url.searchParams.set("model", modelId);
  const response = await fetch(url, {
    method: "GET",
    headers: routerRequestHeaders(),
    redirect: "error",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Health API HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  return body ? JSON.parse(body) : null;
}

function healthIdentityByNode(health, modelId) {
  const model = (health?.models || []).find((item) => item?.modelId === modelId);
  const mapping = new Map();
  for (const entry of model?.entries || []) {
    for (const node of entry.nodes || []) mapping.set(node.nodeName, entry.identityKey);
  }
  return { model, mapping };
}

async function validateRouterHealth({ observedByNode, expectedSameNodes, expectedDistinctNodes }) {
  const routerUrl = env("MIHOMO_ROUTER_URL");
  if (!routerUrl) return;
  const parsed = new URL(routerUrl);
  assertCondition(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, "MIHOMO_ROUTER_URL must not contain credentials, query or fragment");
  const poolId = env("MIHOMO_POOL_ID");
  const modelId = env("MIHOMO_MODEL_ID");
  assertCondition(poolId, "MIHOMO_POOL_ID is required when MIHOMO_ROUTER_URL is set");
  assertCondition(modelId, "MIHOMO_MODEL_ID is required when MIHOMO_ROUTER_URL is set");

  const timeoutMs = Math.max(1000, Number(env("MIHOMO_HEALTH_WAIT_MS", 120000)) || 120000);
  const pollMs = Math.max(500, Number(env("MIHOMO_HEALTH_POLL_MS", 3000)) || 3000);
  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() <= deadline) {
    health = await fetchRouterHealth({ routerUrl: parsed.toString().replace(/\/$/, ""), poolId, modelId });
    const cycle = health?.cycle || {};
    const checks = cycle.businessChecks || {};
    console.log(`[MIHOMO] health status=${health?.status || "unknown"} cycle=${cycle.status || "unknown"} nodes=${cycle.nodes?.mapped || 0}/${cycle.nodes?.total || 0} egresses=${cycle.egresses?.distinct || 0} business=${checks.completed || 0}/${checks.total || 0}`);
    if (cycle.status === "complete") break;
    await sleep(pollMs);
  }
  assertCondition(health?.cycle?.status === "complete", "Health cycle did not complete before MIHOMO_HEALTH_WAIT_MS");

  const { model, mapping } = healthIdentityByNode(health, modelId);
  for (const nodeName of expectedSameNodes) {
    assertCondition(mapping.has(nodeName), `Health matrix did not include expected node: ${nodeName}`);
  }
  if (expectedSameNodes.length > 1) {
    assertCondition(new Set(expectedSameNodes.map((nodeName) => mapping.get(nodeName))).size === 1, "Expected same-IP nodes were split across health identities");
  }
  for (const nodeName of expectedDistinctNodes) {
    assertCondition(mapping.has(nodeName), `Health matrix did not include expected node: ${nodeName}`);
  }
  if (expectedDistinctNodes.length > 1) {
    assertCondition(new Set(expectedDistinctNodes.map((nodeName) => mapping.get(nodeName))).size === expectedDistinctNodes.length, "Expected distinct-IP nodes shared a health identity");
  }
  if (model) {
    console.log(`[MIHOMO] model=${modelId} healthy=${model.healthyEgresses || 0} refreshing=${model.refreshingEgresses || 0} cooling=${model.coolingEgresses || 0}`);
  }
  for (const [nodeName, observed] of observedByNode) {
    if (mapping.has(nodeName) && observed.ip) observed.identityKey = mapping.get(nodeName);
  }
}

async function fetchViaListener(listenerUrl, targetUrl, timeoutMs) {
  const dispatcher = new ProxyAgent({ uri: listenerUrl });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(targetUrl, {
      method: "GET",
      dispatcher,
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "9Router-Mihomo-Validation" },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body: body.slice(0, 500) };
  } finally {
    clearTimeout(timer);
    await dispatcher.close();
  }
}

async function expectListenerFailure(listenerUrl, targetUrl, timeoutMs) {
  try {
    const result = await fetchViaListener(listenerUrl, targetUrl, timeoutMs);
    return !result.ok;
  } catch {
    return true;
  }
}

async function main() {
  const controllerUrl = env("MIHOMO_CONTROLLER_URL");
  const secret = env("MIHOMO_CONTROLLER_SECRET");
  const selectorName = env("MIHOMO_SELECTOR");
  const listenerUrl = env("MIHOMO_LISTENER_URL");
  const echoUrl = env("MIHOMO_IP_ECHO_URL", DEFAULT_ECHO_URL);
  const providerNames = listEnv("MIHOMO_PROVIDER_NAMES");
  const requestedNodes = listEnv("MIHOMO_NODE_NAMES");
  const expectedSameNodes = listEnv("MIHOMO_EXPECTED_SAME_IP_NODES");
  const expectedDistinctNodes = listEnv("MIHOMO_EXPECTED_DISTINCT_NODES");
  const timeoutMs = Math.max(1000, Number(env("MIHOMO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS);

  assertCondition(controllerUrl, "MIHOMO_CONTROLLER_URL is required");
  assertCondition(listenerUrl, "MIHOMO_LISTENER_URL is required");
  assertCondition(selectorName, "MIHOMO_SELECTOR is required");
  const client = createValidationClient({ controllerUrl, secret, timeoutMs });

  const version = await client.getVersion();
  const selector = await client.getProxy(selectorName);
  assertCondition(String(selector?.type || "").toLowerCase() === "selector", `Configured proxy is not a Selector: ${selectorName}`);

  const nodes = await discoverValidationNodes({ client, selector, providerNames });
  assertCondition(nodes.length > 0, "Selector has no eligible leaf nodes");

  const targets = requestedNodes.length > 0
    ? nodes.filter((node) => requestedNodes.includes(node.nodeName))
    : nodes.filter((node) => node.nodeName === selector.now).slice(0, 1);
  const missing = requestedNodes.filter((name) => !targets.some((node) => node.nodeName === name));
  assertCondition(missing.length === 0, `Requested node(s) were not discovered: ${missing.join(", ")}`);
  assertCondition(targets.length > 0, "No target node selected; set MIHOMO_NODE_NAMES or verify Selector.now");

  console.log(`[MIHOMO] Controller version=${version?.version || "unknown"} selector="${selectorName}" candidates=${nodes.length}`);
  if (providerNames.length > 0) console.log(`[MIHOMO] provider(s)=${providerNames.join(", ")}`);

  const observedByNode = new Map();
  for (const node of targets) {
    await client.selectProxy(selectorName, node.nodeName);
    const selected = await client.getProxy(selectorName);
    assertCondition(selected?.now === node.nodeName, `Selector verify failed for node: ${node.nodeName}`);

    const echo = await fetchViaListener(listenerUrl, echoUrl, timeoutMs);
    assertCondition(echo.ok, `IP echo failed through node ${node.nodeName}: HTTP ${echo.status}`);
    const ip = echo.ip || extractEchoIp(echo.body);
    assertCondition(ip, `IP echo did not return a valid IP for node: ${node.nodeName}`);
    observedByNode.set(node.nodeName, { ip });
    console.log(`[MIHOMO] node="${node.nodeName}" listenerStatus=${echo.status} egress=${redactIp(ip)}`);
  }

  const groups = new Map();
  for (const [nodeName, observed] of observedByNode) {
    const members = groups.get(observed.ip) || [];
    members.push(nodeName);
    groups.set(observed.ip, members);
  }
  console.log(`[MIHOMO] observed egress groups=${[...groups.entries()].map(([ip, members]) => `${redactIp(ip)}:${members.length}`).join(", ")}`);
  assertCondition(expectedSameNodes.every((nodeName) => observedByNode.has(nodeName)), "MIHOMO_EXPECTED_SAME_IP_NODES must be included in MIHOMO_NODE_NAMES");
  assertCondition(expectedDistinctNodes.every((nodeName) => observedByNode.has(nodeName)), "MIHOMO_EXPECTED_DISTINCT_NODES must be included in MIHOMO_NODE_NAMES");
  if (expectedSameNodes.length > 1) {
    assertCondition(new Set(expectedSameNodes.map((nodeName) => observedByNode.get(nodeName).ip)).size === 1, "Expected same-IP nodes did not share an observed egress");
  }
  if (expectedDistinctNodes.length > 1) {
    assertCondition(new Set(expectedDistinctNodes.map((nodeName) => observedByNode.get(nodeName).ip)).size === expectedDistinctNodes.length, "Expected distinct-IP nodes shared an observed egress");
  }

  const connections = await client.getConnections();
  const connectionList = Array.isArray(connections) ? connections : connections?.connections;
  console.log(`[MIHOMO] /connections reachable active=${Array.isArray(connectionList) ? connectionList.length : "unknown"}`);

  const failureListenerUrl = env("MIHOMO_FAILURE_LISTENER_URL");
  if (failureListenerUrl) {
    const failedClosed = await expectListenerFailure(failureListenerUrl, echoUrl, timeoutMs);
    assertCondition(failedClosed, "Fail-closed check failed: bad listener unexpectedly returned a successful response");
    console.log("[MIHOMO] fail-closed listener check passed");
  }

  await validateRouterHealth({ observedByNode, expectedSameNodes, expectedDistinctNodes });

  console.log("[MIHOMO] real environment validation passed");
}

main().catch((error) => {
  const secret = env("MIHOMO_CONTROLLER_SECRET");
  console.error(`[MIHOMO] validation failed: ${safeError(error, secret)}`);
  process.exitCode = 1;
});
