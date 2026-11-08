import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeAutomationCreateParams } from "@zcode/shared";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";

// docs/desktop/host-idle-resources-1.1-spec.md §4：scheduler 只在有调度工作时运行，
// 自动化定义变更后由 Host 唤醒。

function makeParams(
  overrides: Partial<ZCodeAutomationCreateParams> = {},
): ZCodeAutomationCreateParams {
  return {
    title: "每日巡检",
    cronExpr: "0 9 * * *",
    prompt: "检查昨天的错误日志并汇总",
    workspacePath: "/tmp/ws",
    recurring: true,
    ...overrides,
  };
}

describe("AutomationRepo.hasSchedulerWork", () => {
  let tempDir: string;
  let repo: AutomationRepo;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-scheduler-work-"));
    repo = new AutomationRepo(join(tempDir, "tasks-index.sqlite"));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("CRON05: 启用、在途认领、待恢复手动运行分别构成调度工作，全部清空后为假", async () => {
    expect(await repo.hasSchedulerWork()).toBe(false);

    const automation = await repo.create(makeParams(), { nextRunAt: Date.now() + 60_000 });
    expect(await repo.hasSchedulerWork()).toBe(true);

    await repo.setEnabled(automation.automationId, false);
    expect(await repo.hasSchedulerWork()).toBe(false);

    // 停用的任务仍可能被立即运行认领：认领期间（running=1、manual run claimed）都要保留 scheduler 做崩溃恢复。
    const claimed = await repo.runNow(automation.automationId, { now: Date.now() });
    expect(claimed).not.toBeNull();
    expect(await repo.hasSchedulerWork()).toBe(true);

    await repo.releaseManualClaim(automation.automationId, claimed!.run.workspaceKey);
    await repo.deleteRun(claimed!.run.runId);
    expect(await repo.hasSchedulerWork()).toBe(false);

    await repo.delete(automation.automationId);
    expect(await repo.hasSchedulerWork()).toBe(false);
  });
});

describe("AutomationService 定义变更通知", () => {
  let tempDir: string;
  let repo: AutomationRepo;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-automation-changed-"));
    repo = new AutomationRepo(join(tempDir, "tasks-index.sqlite"));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("CRON06: 每次成功写入后通知一次，失败或无变更不通知", async () => {
    const changed = vi.fn();
    const service = new AutomationService(repo, undefined, { onChanged: changed });
    const scope = { workspacePath: "/tmp/ws" };

    const automation = await service.create(makeParams());
    expect(changed).toHaveBeenLastCalledWith(automation.automationId);

    await service.update(automation.automationId, { title: "改名" }, scope);
    await service.setEnabled(automation.automationId, false, scope);
    await service.setEnabled(automation.automationId, true, scope);
    const claimed = await service.runNow(automation.automationId, scope);
    expect(claimed).not.toBeNull();
    expect(changed).toHaveBeenCalledTimes(5);

    // 不存在的任务：没有写入，不通知。
    await expect(service.update("automation-missing", { title: "x" }, scope)).resolves.toBeNull();
    await expect(service.delete("automation-missing", scope)).resolves.toBe(false);
    await expect(service.runNow("automation-missing", scope)).resolves.toBeNull();
    expect(changed).toHaveBeenCalledTimes(5);

    // 校验失败（非法 cron）：抛错且不通知。
    await expect(service.create(makeParams({ cronExpr: "not a cron" }))).rejects.toThrow();
    expect(changed).toHaveBeenCalledTimes(5);

    await expect(service.delete(automation.automationId, scope)).resolves.toBe(true);
    expect(changed).toHaveBeenCalledTimes(6);
  });

  it("通知回调抛错不影响写入结果", async () => {
    const service = new AutomationService(repo, undefined, {
      onChanged: () => {
        throw new Error("main 不可达");
      },
    });
    await expect(service.create(makeParams())).resolves.toMatchObject({ title: "每日巡检" });
  });
});
