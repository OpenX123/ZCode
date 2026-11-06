import { describe, expect, it } from "vitest";
import {
  engineConnectionFailureSchema,
  readExternalEngineFailure,
  reduceFailureUrl,
  sanitizeFailureMessage,
} from "../src/external-engine/contract.js";

// 形状取自本机 codex-acp 2.2.2 / claude-agent-acp 0.95.0 的真实帧；秘密均为夹具值。
const CODEX_RETRY = {
  message: "Reconnecting... 2/5",
  codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
  additionalDetails:
    "unexpected status 502 Bad Gateway: upstream connect error, url: https://gateway.example.test/v1/responses?api_key=fixture-secret&x=1, request id: fixture-request-1",
  turnId: "turn-1",
  willRetry: true,
};

describe("外部引擎失败诊断归一", () => {
  it("Codex 重试读取 additionalDetails 的状态、URL 与请求 ID，query 与密钥不外泄", () => {
    const failure = readExternalEngineFailure(CODEX_RETRY);
    expect(failure).toMatchObject({
      code: "provider",
      httpStatus: 502,
      retryable: true,
      requestId: "fixture-request-1",
      url: "https://gateway.example.test/v1/responses",
    });
    expect(failure.message).toContain("unexpected status 502 Bad Gateway");
    expect(failure.message).toContain("https://gateway.example.test/v1/responses");
    expect(JSON.stringify(failure)).not.toContain("fixture-secret");
    expect(JSON.stringify(failure)).not.toContain("api_key");
  });

  it("Claude RPC 错误从 API Error 文本读取状态与 JSON request_id", () => {
    const failure = readExternalEngineFailure(
      {
        code: -32603,
        message:
          'Internal error: API Error: 502 {"type":"error","error":{"type":"api_error","message":"Bad Gateway"},"request_id":"req_fixture01"}',
        data: { errorKind: "server_error" },
      },
      { code: "request", method: "session/prompt", rpcCode: -32603 },
    );
    expect(failure).toMatchObject({
      code: "provider",
      httpStatus: 502,
      requestId: "req_fixture01",
      method: "session/prompt",
      rpcCode: -32603,
    });
    expect(failure.message?.length).toBeLessThanOrEqual(300);
  });

  it("令牌、Bearer 头与凭据赋值脱敏，摘要最多 300 字", () => {
    const message = sanitizeFailureMessage(
      `Authorization failed: Bearer abc.def-ghi token=fixture-token sk-fixtureSecretValue123 ${"x".repeat(400)}`,
    );
    expect(message).not.toContain("abc.def-ghi");
    expect(message).not.toContain("fixture-token");
    expect(message).not.toContain("sk-fixtureSecretValue123");
    expect(message!.length).toBeLessThanOrEqual(300);
  });

  it("URL 只保留 scheme、host 与 path", () => {
    expect(reduceFailureUrl("https://user:pass@example.test:8443/v1/chat?key=1#frag")).toBe(
      "https://example.test:8443/v1/chat",
    );
    expect(reduceFailureUrl("file:///etc/passwd")).toBeUndefined();
  });

  it("旧事件缺少新增字段仍可解析", () => {
    expect(
      engineConnectionFailureSchema.parse({ code: "provider", httpStatus: 502, message: "old" }),
    ).toEqual({ code: "provider", httpStatus: 502, message: "old" });
  });
});
