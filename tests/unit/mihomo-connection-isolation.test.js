import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

let proxy;
let proxyUrl;
let selectedNode = "A";
const connectedNodes = [];

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
    connectedNodes.push(nodeAtConnect);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    let requestBuffer = Buffer.alloc(0);
    const onData = (chunk) => {
      requestBuffer = Buffer.concat([requestBuffer, chunk]);
      if (!requestBuffer.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const chunks = [`${nodeAtConnect}-chunk-1\n`, `${nodeAtConnect}-chunk-2\n`, `${nodeAtConnect}-chunk-3\n`];
      const bodyLength = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${bodyLength}\r\nConnection: close\r\n\r\n`);
      socket.write(chunks[0]);
      setTimeout(() => socket.write(chunks[1]), 10);
      setTimeout(() => {
        socket.write(chunks[2]);
        socket.end();
      }, 20);
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

describe("Mihomo managed connection isolation", () => {
  it("binds every new request to the Selector value at CONNECT time and preserves slow streaming", async () => {
    const options = {
      connectionProxyEnabled: true,
      connectionProxyUrl: proxyUrl,
      strictProxy: true,
      ephemeralProxyDispatcher: true,
    };

    selectedNode = "A";
    const responseA = await proxyAwareFetch("http://upstream.invalid/stream", {}, options);
    const bodyA = await responseA.text();

    selectedNode = "B";
    const responseB = await proxyAwareFetch("http://upstream.invalid/stream", {}, options);
    const bodyB = await responseB.text();

    expect(connectedNodes).toEqual(["A", "B"]);
    expect(bodyA).toContain("A-chunk-1");
    expect(bodyA).toContain("A-chunk-2");
    expect(bodyA).toContain("A-chunk-3");
    expect(bodyB).toContain("B-chunk-1");
    expect(bodyB).toContain("B-chunk-2");
    expect(bodyB).toContain("B-chunk-3");
  });
});
