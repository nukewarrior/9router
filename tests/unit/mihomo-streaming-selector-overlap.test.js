import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { withMihomoSelectorLease } from "../../src/lib/network/mihomoRouteManager.js";

let proxy;
let proxyUrl;
let selectedNode;
let connectedNodes;
let activeScenario;

function deferred() {
  let resolve;
  let settled = false;
  const promise = new Promise((resolver) => {
    resolve = (value) => {
      settled = true;
      resolver(value);
    };
  });
  return { promise, resolve, get settled() { return settled; } };
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

beforeAll(async () => {
  proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    const nodeAtConnect = selectedNode;
    const scenario = activeScenario;
    connectedNodes.push(nodeAtConnect);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    let requestBuffer = Buffer.alloc(0);
    const onData = async (chunk) => {
      requestBuffer = Buffer.concat([requestBuffer, chunk]);
      if (!requestBuffer.includes("\r\n\r\n")) return;
      socket.off("data", onData);

      const chunks = [`${nodeAtConnect}-chunk-1\n`, `${nodeAtConnect}-chunk-2\n`, `${nodeAtConnect}-chunk-3\n`];
      const bodyLength = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${bodyLength}\r\nConnection: close\r\n\r\n`);
      socket.write(chunks[0]);

      if (nodeAtConnect === "A") {
        scenario.headersSent.resolve();
        await scenario.releaseA.promise;
      }

      socket.write(chunks[1]);
      socket.write(chunks[2]);
      socket.end();
      if (nodeAtConnect === "A") scenario.bodyEnded.resolve();
    };
    socket.on("data", onData);
  });
  await waitForListening(proxy);
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

afterAll(async () => {
  proxy.closeAllConnections?.();
  await new Promise((resolve) => proxy.close(resolve));
});

describe("Mihomo Selector streaming overlap", () => {
  it("switches to B after A headers while A body remains complete", async () => {
    const scenario = {
      headersSent: deferred(),
      releaseA: deferred(),
      bodyEnded: deferred(),
    };
    connectedNodes = [];
    activeScenario = scenario;
    selectedNode = "A";

    const pool = {
      id: "pool-overlap",
      type: "mihomo",
      isActive: true,
      proxyUrl,
      mihomo: {
        controllerUrl: "http://127.0.0.1:9090",
        controllerSecret: "secret",
        selectorName: "selector",
      },
    };
    const client = {
      selectProxy: async (_selector, nodeName) => {
        selectedNode = nodeName;
      },
      getProxy: async () => ({ type: "Selector", now: selectedNode }),
    };
    const lease = (nodeName, callback) => withMihomoSelectorLease({
      poolId: pool.id,
      nodeName,
      getPool: async () => pool,
      makeClient: () => client,
    }, callback);

    try {
      const requestA = lease("A", (proxyOptions) => proxyAwareFetch("http://upstream.invalid/stream", {}, proxyOptions));
      await scenario.headersSent.promise;
      const responseA = await requestA;

      expect(scenario.bodyEnded.settled).toBe(false);

      const responseB = await lease("B", (proxyOptions) => proxyAwareFetch("http://upstream.invalid/stream", {}, proxyOptions));
      expect(connectedNodes).toEqual(["A", "B"]);
      expect(scenario.bodyEnded.settled).toBe(false);

      scenario.releaseA.resolve();
      const [bodyA, bodyB] = await Promise.all([responseA.text(), responseB.text()]);

      expect(bodyA).toBe("A-chunk-1\nA-chunk-2\nA-chunk-3\n");
      expect(bodyB).toBe("B-chunk-1\nB-chunk-2\nB-chunk-3\n");
      await scenario.bodyEnded.promise;
    } finally {
      scenario.releaseA.resolve();
      activeScenario = null;
      connectedNodes = null;
      selectedNode = null;
    }
  });
});
