import { describe, expect, it } from "vitest";
import {
  mcpServerFailureKindSchema,
  zcodeMcpServerStatusSnapshotSchema,
} from "../src/zcode-protocol/index.js";

describe("MCP status diagnostics protocol", () => {
  it("accepts structured failure diagnostics and keeps legacy snapshots compatible", () => {
    expect(
      zcodeMcpServerStatusSnapshotSchema.parse({
        error: "raw sdk error",
        failureKind: "server_unavailable",
        serverRequestId: "20260822000000abcdef1234567890abcd",
        status: "failed",
        toolCount: 0,
        transport: "http",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).toMatchObject({
      failureKind: "server_unavailable",
      serverRequestId: "20260822000000abcdef1234567890abcd",
    });

    expect(
      zcodeMcpServerStatusSnapshotSchema.parse({
        status: "connected",
        toolCount: 3,
        transport: "stdio",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).not.toHaveProperty("failureKind");
  });

  it.each(["official_origin_untrusted", "not_authenticated", "coding_plan_required"])(
    "仅在旧快照读取边界剥离已退役官方失败类别（%s）",
    (failureKind) => {
      const input = {
        status: "failed",
        transport: "http",
        toolCount: 0,
        updatedAt: "2026-10-24T00:00:00.000Z",
        failureKind,
        error: "saved diagnostic",
        serverRequestId: "request-1",
        authorization: {
          type: "oauth_authorization_code",
          authorizationUrl: "https://mcp.example/authorize",
          startedAt: "2026-10-24T00:00:00.000Z",
        },
      };
      const snapshot = zcodeMcpServerStatusSnapshotSchema.parse(input);
      expect(snapshot.failureKind).toBeUndefined();
      expect(snapshot.error).toBe(input.error);
      expect(snapshot.authorization).toEqual(input.authorization);
      expect(snapshot.serverRequestId).toBe(input.serverRequestId);
      expect(input.failureKind).toBe(failureKind);
      expect(mcpServerFailureKindSchema.safeParse(failureKind).success).toBe(false);
    },
  );

  it("普通 MCP OAuth 失败保留，未知失败类别仍严格拒绝", () => {
    const base = {
      status: "failed",
      transport: "http",
      toolCount: 0,
      updatedAt: "2026-10-24T00:00:00.000Z",
    };
    expect(
      zcodeMcpServerStatusSnapshotSchema.parse({
        ...base,
        failureKind: "oauth_authorization_failed",
      }).failureKind,
    ).toBe("oauth_authorization_failed");
    expect(
      zcodeMcpServerStatusSnapshotSchema.safeParse({ ...base, failureKind: "unrecognized_failure" })
        .success,
    ).toBe(false);
  });

  it("rejects empty request ids", () => {
    expect(
      zcodeMcpServerStatusSnapshotSchema.safeParse({
        serverRequestId: "",
        status: "failed",
        toolCount: 0,
        transport: "http",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
