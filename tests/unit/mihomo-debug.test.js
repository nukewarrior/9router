import { describe, expect, it } from "vitest";
import {
  mihomoErrorFields,
  resolveMihomoRequestId,
  sanitizeProxyUrl,
  sanitizeTarget,
  serializeMihomoError,
} from "../../open-sse/utils/mihomoDebug.js";

describe("Mihomo debug helpers", () => {
  it("sanitizes proxy credentials while retaining the listener address", () => {
    expect(sanitizeProxyUrl("http://user:super-secret@10.11.11.1:17891")).toBe("http://10.11.11.1:17891");
  });

  it("keeps only protocol, host and port for request targets", () => {
    expect(sanitizeTarget("https://opencode.ai/v1/chat?token=secret")).toEqual({
      protocol: "https",
      hostname: "opencode.ai",
      port: "443",
      authority: "opencode.ai:443",
    });
  });

  it("prefers an inbound request id and normalizes unsafe characters", () => {
    expect(resolveMihomoRequestId({ clientRawRequest: { headers: { "x-request-id": "req/91 bc" } } })).toBe("req-91-bc");
  });

  it("serializes a bounded error cause chain without secrets", () => {
    const root = new TypeError("fetch failed");
    root.cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      cause: Object.assign(new Error("http://user:password@router.invalid/reset"), { code: "ECONNRESET" }),
    });

    expect(serializeMihomoError(root)).toEqual([
      { name: "TypeError", message: "fetch failed" },
      { name: "Error", message: "Connect Timeout Error", code: "UND_ERR_CONNECT_TIMEOUT" },
      { name: "Error", message: "http://[redacted]@router.invalid/reset", code: "ECONNRESET" },
    ]);
    expect(mihomoErrorFields(root)).toMatchObject({
      "error.name": "TypeError",
      "cause[1].code": "UND_ERR_CONNECT_TIMEOUT",
    });
  });

  it("caps circular and deeply nested causes", () => {
    const first = new Error("A");
    const second = new Error("B");
    const third = new Error("C");
    const fourth = new Error("D");
    const fifth = new Error("E");
    first.cause = second;
    second.cause = third;
    third.cause = fourth;
    fourth.cause = fifth;
    fifth.cause = first;

    expect(serializeMihomoError(first)).toHaveLength(4);
  });
});
