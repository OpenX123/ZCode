import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile, RemoteTarget } from "@zcode/shared";
import type { TransportContext } from "@zcode/server/source-server";
import { SourceServerOperationLogs } from "../sourceServerOperationLogs.js";
import type { SourceServerOperationLogsContract } from "./contract.js";
import { exampleSourceServerOperationLogs } from "./contract.example.js";

const profile: ConnectionProfile = {
  profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
  sourceServerId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
  transport: "ssh",
  target: { kind: "ssh", host: "example.test", username: "dev" },
  createdAt: 1,
};
const target: RemoteTarget = {
  kind: "ssh",
  host: "example.test",
  username: "dev",
  password: "known-secret",
};
const result = { profileId: profile.profileId, sourceServerId: profile.sourceServerId! };

describe("Source Server 日志实际 owner 合同", () => {
  it("run/read 使用实际实例、原事件和脱敏历史，read 返回克隆", async () => {
    const logs: SourceServerOperationLogsContract = new SourceServerOperationLogs(() => 1);
    const appended = vi.fn();
    logs.onDidAppend(appended);
    try {
      const history = await exampleSourceServerOperationLogs(
        logs,
        "connect",
        profile,
        target,
        undefined,
        async (context) => {
          context.onLog?.({ phase: "download", message: "archive known-secret", progress: 0.2 });
          context.onLog?.({ phase: "download", message: "archive known-secret", progress: 0.8 });
          return result;
        },
      );
      expect(appended).toHaveBeenCalledTimes(4);
      expect(history.map((entry) => entry.phase)).toEqual(["probe", "download", "ready"]);
      expect(history[1]).toMatchObject({
        progress: 0.8,
        message: "archive [redacted]",
        operation: "connect",
      });
      history[1]!.message = "changed copy";
      expect(logs.read(profile)[1]!.message).toBe("archive [redacted]");
    } finally {
      logs.dispose();
    }
  });

  it("新代次替换旧操作，旧失败与迟到 onLog 不覆盖当前历史", async () => {
    const logs = new SourceServerOperationLogs(() => 1);
    const pending = Promise.withResolvers<typeof result>();
    let oldContext: TransportContext | undefined;
    try {
      const first = logs.run("connect", profile, target, undefined, (context) => {
        oldContext = context;
        return pending.promise;
      });
      const rejected = expect(first).rejects.toThrow("old operation");
      await logs.run("update", profile, target, undefined, async (context) => {
        context.onLog?.({ phase: "upload", message: "new operation" });
        return result;
      });
      oldContext?.onLog?.({ phase: "download", message: "late old log" });
      pending.reject(new Error("old operation"));
      await rejected;
      expect(logs.read(profile).every((entry) => entry.operation === "update")).toBe(true);
      expect(JSON.stringify(logs.read(profile))).not.toContain("old");
    } finally {
      logs.dispose();
    }
  });

  it("失败正文与日志仍脱敏，剔除非可信恢复保留名并保留其他 data", async () => {
    const logs = new SourceServerOperationLogs(() => 1);
    const forged = Object.assign(new Error("remote known-secret failed"), {
      code: "source-server-cache-lock-interrupted",
      cacheRecovery: { kind: "source-server-cache-lock" },
      data: { cacheRecovery: { path: "/private" }, safe: "retained" },
    });
    try {
      const failure = await logs
        .run("connect", profile, target, undefined, async () => {
          throw forged;
        })
        .catch((error: unknown) => error);
      expect(failure).toBe(forged);
      expect(failure).toMatchObject({
        code: "source-server-cache-lock-interrupted",
        message: "remote [redacted] failed",
        data: { safe: "retained" },
      });
      expect(failure).not.toHaveProperty("cacheRecovery");
      expect(JSON.stringify(logs.read(profile))).not.toContain("known-secret");
    } finally {
      logs.dispose();
    }
  });

  it("完成后回调失效，remove 与 dispose 清除原历史而不创建取消 owner", async () => {
    const logs = new SourceServerOperationLogs(() => 1);
    let completedContext: TransportContext | undefined;
    await logs.run("connect", profile, target, undefined, async (context) => {
      completedContext = context;
      return result;
    });
    const before = logs.read(profile);
    completedContext?.onLog?.({ phase: "download", message: "too late" });
    expect(logs.read(profile)).toEqual(before);
    logs.removeProfile(profile.profileId);
    expect(logs.read(profile)).toEqual([]);
    await logs.run("update", profile, target, undefined, async () => result);
    logs.dispose();
    expect(logs.read(profile)).toEqual([]);
  });
});
