import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AcpConnection } from "../src/external-engine/connection.js";

describe("ACP安全错误诊断", () => {
  it.each([
    { error: "invalid error" },
    { error: null },
    { error: false },
    { error: {} },
    { error: { code: -32603 } },
    { error: { code: "-32603", message: "invalid code" } },
    { result: null },
    { result: [] },
    { result: {}, error: { code: -32603 } },
    {},
  ])("畸形RPC响应立即拒绝prompt，不遗失在途promise：%j", async (response) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams;
    const connection = new AcpConnection(child);
    const pending = connection.request("session/prompt", {});
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, ...response }) + "\n");
    await expect(pending).rejects.toMatchObject({
      failure: { code: "protocol", method: "session/prompt" },
    });
    expect(connection.healthy).toBe(false);
  });
  it("RPC 502保留状态与request id，同时剔除URL和凭据", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams;
    const connection = new AcpConnection(child);
    const response = connection.request("session/prompt", {});
    const verdict = response.catch((error: unknown) => error);
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message:
            "unexpected status 502 Bad Gateway; request id: fixture-request; https://example.test/responses?api_key=fixture-secret",
          data: { authorization: "Bearer fixture-secret", requestId: "fixture-request" },
        },
      }) + "\n",
    );
    const error = await verdict;
    expect(error).toMatchObject({
      failure: {
        code: "provider",
        httpStatus: 502,
        requestId: "fixture-request",
        method: "session/prompt",
        rpcCode: -32603,
      },
    });
    expect(JSON.stringify(error)).not.toContain("fixture-secret");
    expect(JSON.stringify(error)).not.toContain("example.test");
  });
});
