import { describe, expect, it } from "vitest";
import {
  canRestartAutomation,
  canToggleAutomation,
  getAutomationActionErrorToastId,
  getAutomationCreateErrorToastId,
  getAutomationRunNowToastId,
  resolveAutomationDetailNavigation,
  resolveAutomationDetailTarget,
} from "@/settings/AutomationsSection.js";

describe("canRestartAutomation", () => {
  it("只允许 failed 定时任务展示重启入口", () => {
    expect(canRestartAutomation({ lifecycleStatus: "failed" })).toBe(true);
    expect(canRestartAutomation({ lifecycleStatus: "completed" })).toBe(false);
    expect(canRestartAutomation({ lifecycleStatus: "active" })).toBe(false);
    expect(canRestartAutomation({ lifecycleStatus: "paused" })).toBe(false);
  });

  it("completed 和 failed 终态不展示暂停或恢复入口", () => {
    expect(canToggleAutomation({ lifecycleStatus: "active" })).toBe(true);
    expect(canToggleAutomation({ lifecycleStatus: "paused" })).toBe(true);
    expect(canToggleAutomation({ lifecycleStatus: "completed" })).toBe(false);
    expect(canToggleAutomation({ lifecycleStatus: "failed" })).toBe(false);
  });

  it("重复立即运行会映射到正在运行提示", () => {
    expect(getAutomationRunNowToastId("queued")).toBe("automations.runNowQueued");
    expect(getAutomationRunNowToastId("duplicate")).toBe("automations.runNowAlreadyRunning");
    expect(getAutomationRunNowToastId("failed")).toBe("automations.runNowFailed");
  });

  it("管理操作失败映射为产品文案，不直接展示 RPC 原文", () => {
    expect(getAutomationActionErrorToastId("create")).toBe("automations.error.create");
    expect(getAutomationActionErrorToastId("update")).toBe("automations.error.update");
    expect(getAutomationActionErrorToastId("toggle")).toBe("automations.error.toggle");
    expect(getAutomationActionErrorToastId("restart")).toBe("automations.error.restart");
    expect(getAutomationActionErrorToastId("delete")).toBe("automations.error.delete");
    expect(
      getAutomationCreateErrorToastId("[AUTOMATION_CREATE_LIMIT_REACHED] automation limit reached"),
    ).toBe("automations.error.createLimit");
    expect(getAutomationCreateErrorToastId("rpc unavailable")).toBe("automations.error.create");
  });

  it("会话创建卡片按 automationId 定位对应详情", () => {
    const target = { automationId: "automation-target" } as never;
    const other = { automationId: "automation-other" } as never;

    expect(resolveAutomationDetailTarget([other, target], " automation-target ")).toBe(target);
    expect(resolveAutomationDetailTarget([other], "automation-target")).toBeNull();
    expect(resolveAutomationDetailTarget([target], undefined)).toBeNull();
  });

  it("详情导航等待列表完成，并在目标不存在时进入可消费的失败终态", () => {
    const target = { automationId: "automation-target" } as never;

    expect(resolveAutomationDetailNavigation([], "automation-target", false)).toEqual({
      status: "pending",
    });
    expect(resolveAutomationDetailNavigation([target], "automation-target", true)).toEqual({
      status: "found",
      target,
    });
    expect(resolveAutomationDetailNavigation([], "automation-target", true)).toEqual({
      status: "missing",
    });
  });
});
