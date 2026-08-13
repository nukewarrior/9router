import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_CONTROLLER_URL = "http://10.11.11.1:9090";
const DEFAULT_LISTENER_URL = "http://10.11.11.1:17891";
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
  return message.replace(/(Bearer\s+)[^\s,]+/gi, "$1[redacted]");
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
      const response = await fetch(new URL(path.replace(/^\//, ""), `${baseUrl}/`), {
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

function classifyRegion(nodeName) {
  const name = String(nodeName || "").toLowerCase();
  const patterns = [
    ["TW", /🇹🇼|台湾|taiwan|\btw\b/iu],
    ["JP", /🇯🇵|日本|japan|\bjp\b/iu],
    ["US", /🇺🇸|美国|usa|united\s+states|\bus\b/iu],
    ["SG", /🇸🇬|新加坡|singapore|\bsg\b/iu],
    ["HK", /🇭🇰|香港|hong\s+kong|\bhk\b/iu],
    ["KR", /🇰🇷|韩国|korea|\bkr\b/iu],
  ];
  return patterns.find(([, pattern]) => pattern.test(name))?.[0] || "OTHER";
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
      region: classifyRegion(nodeName),
      alive: metadata.alive === true ? true : null,
    });
  }
  return nodes;
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
  const controllerUrl = env("MIHOMO_CONTROLLER_URL", DEFAULT_CONTROLLER_URL);
  const secret = env("MIHOMO_CONTROLLER_SECRET");
  const selectorName = env("MIHOMO_SELECTOR");
  const listenerUrl = env("MIHOMO_LISTENER_URL", DEFAULT_LISTENER_URL);
  const echoUrl = env("MIHOMO_IP_ECHO_URL", DEFAULT_ECHO_URL);
  const providerNames = listEnv("MIHOMO_PROVIDER_NAMES");
  const requestedNodes = listEnv("MIHOMO_NODE_NAMES");
  const timeoutMs = Math.max(1000, Number(env("MIHOMO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS);

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

  for (const node of targets) {
    await client.selectProxy(selectorName, node.nodeName);
    const selected = await client.getProxy(selectorName);
    assertCondition(selected?.now === node.nodeName, `Selector verify failed for node: ${node.nodeName}`);

    const echo = await fetchViaListener(listenerUrl, echoUrl, timeoutMs);
    assertCondition(echo.ok, `IP echo failed through node ${node.nodeName}: HTTP ${echo.status}`);
    console.log(`[MIHOMO] node="${node.nodeName}" region=${node.region} listenerStatus=${echo.status} echo=${echo.body}`);
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

  console.log("[MIHOMO] real environment validation passed");
}

main().catch((error) => {
  const secret = env("MIHOMO_CONTROLLER_SECRET");
  console.error(`[MIHOMO] validation failed: ${safeError(error, secret)}`);
  process.exitCode = 1;
});
