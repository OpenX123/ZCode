// desktop main 侧的 cron scheduler 进程管理器。
// 职责：拉起/销毁常驻 scheduler 进程；把 scheduler 的派发请求路由给某个本地 host（转成 CronRun）；
// 把 host 回报的 CronRunResult 转回 scheduler 结算。scheduler 只碰 tasks-index，createTask 在 host 域执行。
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";
import type {
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "../scheduler/schedulerProtocol.js";

export interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 选一个能执行本地 workspace 派发的 host；无可用 host 时返回 null（scheduler 会退避重试）。 */
  resolveDispatchHost: () => ElectronUtilityProcess | null;
}

interface CronSchedulerProcessDeps extends CronSchedulerDeps {
  /** 拉起时的最新唤醒序号，经环境变量交给 scheduler（空闲报告回带）。 */
  initialWakeSeq?: number;
  /** scheduler 报告本轮没有调度工作。 */
  onIdle?: (wakeSeq: number) => void;
  /** scheduler 进程退出（含优雅退出、强杀与意外退出）。 */
  onExit?: () => void;
}

export interface CronSchedulerHandle {
  /** host 回报派发结果时调用，转交给 scheduler 结算。 */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /** 自动化定义或认领提交后立即唤醒 scheduler，不等待下一次轮询。 */
  wake: (automationId: string, wakeSeq?: number) => void;
  /** app 退出前优雅收尾（通知 scheduler 释放认领 + 关库，兜底强杀）。 */
  dispose: () => Promise<void>;
}

export interface CronSchedulerSupervisor extends CronSchedulerHandle {
  /** 本地数据库准备完成后拉起首个 scheduler（处理错过窗口、僵尸认领与到期派发）。 */
  start: () => void;
}

const DISPOSE_FORCE_KILL_MS = 1_500;

/**
 * scheduler 按需运行的唯一生命周期所有者（docs/desktop/host-idle-resources-1.1-spec.md §4）。
 * 修复原因（2026-11-08 本机扫描）：scheduler 112MB 无条件常驻，没有启用的自动化也一直在跑。
 *
 * 调度事实只在 tasks-index（AutomationRepo），这里只维护进程状态与单调唤醒序号：
 * - scheduler 每轮查询无调度工作时报告 idle(wakeSeq)；只有序号等于最新唤醒才优雅退出，
 *   查询早于某次提交时，那次提交对应的唤醒序号一定更大，报告被忽略。
 * - Host 提交定义/认领后经 wake 到达：运行中则带序号转发；已退出则以当前序号拉起；
 *   正在空闲退出则退出完成后立即重新拉起，新进程首轮读取已提交的数据。
 */
export function createCronSchedulerSupervisor(deps: CronSchedulerDeps): CronSchedulerSupervisor {
  interface Entry {
    handle: CronSchedulerHandle;
    state: "running" | "idle-disposing";
  }
  let current: Entry | null = null;
  let wakeSeq = 0;
  let respawnAfterExit = false;
  let shutdown = false;

  const handleExit = (entry: Entry): void => {
    if (current !== entry) return;
    current = null;
    if (respawnAfterExit && !shutdown) {
      respawnAfterExit = false;
      spawn();
    }
  };

  const handleIdle = (entry: Entry, reportedWakeSeq: number): void => {
    if (shutdown || current !== entry || entry.state !== "running") return;
    if (reportedWakeSeq !== wakeSeq) return;
    entry.state = "idle-disposing";
    deps.logger.info(`[cron-scheduler] no schedulable automations; stopping wakeSeq=${wakeSeq}`);
    void entry.handle.dispose().then(() => handleExit(entry));
  };

  function spawn(): void {
    // 子进程事件都是异步到达的；回调按 entry identity 归属，迟到的旧进程事件不会影响新进程。
    let entry: Entry | undefined;
    try {
      const handle = spawnCronScheduler({
        ...deps,
        initialWakeSeq: wakeSeq,
        onIdle: (reportedWakeSeq) => {
          if (entry) handleIdle(entry, reportedWakeSeq);
        },
        onExit: () => {
          if (entry) handleExit(entry);
        },
      });
      entry = { handle, state: "running" };
      current = entry;
    } catch (error) {
      deps.logger.error("[cron-scheduler] failed to spawn scheduler process:", error);
    }
  }

  return {
    start() {
      if (!shutdown && !current) spawn();
    },
    wake(automationId) {
      if (shutdown) return;
      wakeSeq += 1;
      if (!current) {
        spawn();
        return;
      }
      if (current.state === "running") current.handle.wake(automationId, wakeSeq);
      else respawnAfterExit = true;
    },
    handleCronRunResult(result) {
      if (shutdown) return;
      // 结果只会来自曾经派发的 scheduler；它意外退出后重新拉起一个来结算（原先结果直接丢失）。
      if (!current) spawn();
      if (current?.state === "running") current.handle.handleCronRunResult(result);
      else
        deps.logger.warn(
          `[cron-scheduler] dispatch result arrived while scheduler is stopping runId=${result.runId}`,
        );
    },
    dispose() {
      shutdown = true;
      const entry = current;
      current = null;
      return entry ? entry.handle.dispose() : Promise.resolve();
    },
  };
}

export function spawnCronScheduler(deps: CronSchedulerProcessDeps): CronSchedulerHandle {
  const child = electronUtilityProcess.fork(schedulerModulePath, [], {
    serviceName: "zcode-cron-scheduler",
    execArgv: ["--no-warnings"],
    env: {
      ...buildHostProcessEnv(deps.hostProcessLocalEnv),
      ZCODE_PROCESS_LABEL: "scheduler",
      ZCODE_SCHEDULER_WAKE_SEQ: String(deps.initialWakeSeq ?? 0),
    },
  });

  deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
  // 资源遥测的 scheduler 角色 pid 只有 spawn 点知道，这里登记到进程角色注册表。
  registerSchedulerProcess(child);
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    try {
      child.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  child.on("message", (raw: unknown) => {
    const msg = raw as SchedulerToMainMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "scheduler-log") {
      const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
      deps.logger[level](`[cron-scheduler] ${msg.message}`);
      return;
    }

    // scheduler 自采的 60 秒样本：main 只取 heap 作 scheduler 角色事件的 heap 维度，
    // 非法样本在入口按 schema 丢弃。
    if (msg.type === "scheduler-resource-sample") {
      ingestSchedulerSelfResourceSample(msg.sample);
      return;
    }

    if (msg.type === "scheduler-idle") {
      if (typeof msg.wakeSeq === "number" && Number.isSafeInteger(msg.wakeSeq))
        deps.onIdle?.(msg.wakeSeq);
      return;
    }

    if (msg.type === "cron-dispatch-request") {
      if (isDisposing) {
        // App 退出时 Cron 与 Host 并行收口；进入 disposing 后继续派发会把新任务
        // 发送给正在关闭的 Host。明确拒绝派发，避免为了保持串行而额外增加 1.5 秒退出延迟。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "app is shutting down",
        });
        return;
      }
      const host = deps.resolveDispatchHost();
      if (!host) {
        // 没有可派发的本地 host（无窗口/未就绪）：按 transient 回执，scheduler 退避后重试。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.CronRun,
          automationId: msg.automationId,
          runId: msg.runId,
          prompt: msg.prompt,
          targetTaskId: msg.targetTaskId,
          modelSelection: msg.modelSelection,
          mode: msg.mode,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
          projectId: msg.projectId,
          hostId: msg.hostId,
          additionalDirectories: msg.additionalDirectories,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
  });

  child.on("exit", (code) => {
    unregisterSchedulerProcess(child);
    deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
    deps.onExit?.();
  });

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    wake(automationId, wakeSeq) {
      if (isDisposing) return;
      postToScheduler({
        type: "scheduler-wake",
        automationId,
        ...(wakeSeq === undefined ? {} : { wakeSeq }),
      });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      isDisposing = true;
      postToScheduler({ type: "scheduler-dispose" });
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 忽略。
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
      });
      return disposePromise;
    },
  };
}
