import { expect, it } from "vitest";
import { readExternalEngineFailure } from "#src/external-engine/contract.js";

it.each([401, 403, 429, 502])(
  "HTTP %s 保留安全状态与分类，响应正文和鉴权信息不下发",
  (httpStatus) => {
    const failure = readExternalEngineFailure(
      {
        message: `unexpected status ${httpStatus}; request id: fixture-request; Authorization: Bearer fixture-secret\nresponse: private prompt text`,
        data: { requestId: "fixture-request", api_key: "fixture-secret" },
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: httpStatus } },
      },
      { code: "request", method: "session/prompt", rpcCode: -32603 },
    );
    expect(failure).toMatchObject({
      httpStatus,
      requestId: "fixture-request",
      code: httpStatus === 401 || httpStatus === 403 ? "authentication" : "provider",
      retryable: httpStatus === 429 || httpStatus >= 500,
      method: "session/prompt",
    });
    expect(JSON.stringify(failure)).not.toContain("fixture-secret");
    expect(JSON.stringify(failure)).not.toContain("private prompt text");
  },
);

it("URL连同主机和鉴权参数全部移除，未知错误仍保留有界摘要", () => {
  const failure = readExternalEngineFailure({
    message: `HTTP 502 at https://fixture.example.test/responses?api_key=fixture-secret; body: private body`,
  });
  expect(failure).toMatchObject({ code: "provider", httpStatus: 502 });
  expect(failure.message).toContain("HTTP 502");
  expect(JSON.stringify(failure)).not.toMatch(/fixture-secret|fixture\.example\.test|private body/);
  expect(readExternalEngineFailure({ message: "x".repeat(1000) }).message).toHaveLength(320);
  expect(
    readExternalEngineFailure({ data: { requestId: "invalid\nrequest" } }).requestId,
  ).toBeUndefined();
});
