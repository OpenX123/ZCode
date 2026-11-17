import { describe, expect, it } from "vitest";
import {
  isDirectoryWriteDeniedProvisioningWarning,
  parseProvisioningSyncEvents,
} from "./e2e/helpers/provisioning-sync-evidence.js";

const context = {
  environmentKey: "env-a",
  trigger: "personal-config",
  status: "failed",
  durationMs: 14,
};
const warning = `[2026-09-25 00:10:00] [warn] [pid:123] [main] [provider-provisioning] Environment sync did not apply ${JSON.stringify(context)}`;

// 与真实 Main 结果同形；只用测试 Environment 和白名单阶段码，不携带远端自由错误。
function directoryWriteDeniedLine(overrides: Record<string, unknown> = {}) {
  return `[2026-11-17 08:39:08.577] [warn] [pid:123] [main] [provider-provisioning] Environment sync did not apply ${JSON.stringify(
    {
      ...context,
      status: "rollback_failed",
      errorCode: "target-write-failed",
      ...overrides,
    },
  )}\n`;
}

describe("真实 Main Provisioning 结果取证", () => {
  it("保留成功与失败两类事件，供提交数和返回数对账", () => {
    const completed = warning
      .replace("[warn]", "[info]")
      .replace("sync did not apply", "sync completed")
      .replace('"status":"failed"', '"status":"applied"');
    expect(parseProvisioningSyncEvents(`${completed}\n${warning}\n`)).toEqual([
      { kind: "completed", ...context, status: "applied" },
      { kind: "warning", ...context },
    ]);
  });

  it("识别结构化 warning，不把 renderer 转述算成 Main 执行结果", () => {
    expect(
      parseProvisioningSyncEvents(`${warning}\n${warning.replace("[main]", "[renderer]")}\n`),
    ).toEqual([{ kind: "warning", ...context }]);
  });

  it("完成日志与失败状态矛盾时拒绝取证，不能伪装成已应用", () => {
    const wrong = warning
      .replace("[warn]", "[info]")
      .replace("sync did not apply", "sync completed");
    expect(() => parseProvisioningSyncEvents(`${wrong}\n`)).toThrow();
  });

  it("仅忽略正在追加的末行，完整写入后保留真实事件", () => {
    expect(parseProvisioningSyncEvents(warning)).toEqual([]);
    expect(parseProvisioningSyncEvents(`${warning}\n`)).toHaveLength(1);
  });

  it("缺少 Environment 身份的完整记录必须报错", () => {
    expect(() =>
      parseProvisioningSyncEvents(`${warning.replace('"environmentKey":"env-a",', "")}\n`),
    ).toThrow();
  });

  it("真实目录拒写的回滚失败保留独立状态及安全阶段码，丢弃自由错误", () => {
    expect(
      parseProvisioningSyncEvents(
        directoryWriteDeniedLine({ errorMessage: "不得转抄的远端自由错误", extraPayload: "忽略" }),
      ),
    ).toEqual([
      {
        ...context,
        kind: "warning",
        status: "rollback_failed",
        errorCode: "target-write-failed",
      },
    ]);
  });

  it.each(["unknown-stage", "", 42])("完整事件的非法安全码必须拒绝: %j", (errorCode) => {
    expect(() => parseProvisioningSyncEvents(directoryWriteDeniedLine({ errorCode }))).toThrow();
  });

  it("PRV12 只接受当前 Environment 的持续目录拒写与回滚失败组合", () => {
    const [event] = parseProvisioningSyncEvents(directoryWriteDeniedLine());
    expect(isDirectoryWriteDeniedProvisioningWarning(event!, "env-a")).toBe(true);
  });

  it.each([
    { environmentKey: "env-other" },
    { trigger: "environment-online" },
    { status: "failed" },
    { status: "unsupported" },
    { errorCode: "target-refresh-failed" },
    { errorCode: "target-apply-failed" },
    { errorCode: undefined },
  ])("PRV12 不能泛化接受其它失败或旧缺码: %j", (overrides) => {
    const [event] = parseProvisioningSyncEvents(directoryWriteDeniedLine(overrides));
    expect(isDirectoryWriteDeniedProvisioningWarning(event!, "env-a")).toBe(false);
  });

  it("错误日志级别不能被状态分类器当作有效 warning", () => {
    expect(() =>
      parseProvisioningSyncEvents(directoryWriteDeniedLine().replace("[warn]", "[info]")),
    ).toThrow();
  });
});
