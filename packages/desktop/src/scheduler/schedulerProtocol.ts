// scheduler(utilityProcess) ↔ main 的控制消息协议。两端都在 Electron 侧，走 parentPort.postMessage。
// 与 host↔main 的 CronRun/CronRunResult(见 @zcode/shared channels + validation)不同：
// 这层是 main 与「常驻 cron scheduler 进程」之间的私有通道；main 收到派发请求后再翻译成 CronRun 转发给 host。
import type { ModelSelection, NodeSelfResourceSample } from "@zcode/shared";

/** scheduler → main */
export type SchedulerToMainMessage =
  | {
      type: "cron-dispatch-request";
      automationId: string;
      runId: string;
      prompt: string;
      targetTaskId?: string;
      modelSelection?: ModelSelection;
      mode?: string;
      workspacePath: string;
      workspaceIdentity?: string;
      projectId?: string | null;
      hostId?: string;
      additionalDirectories?: string[];
    }
  | {
      type: "scheduler-log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      // scheduler 进程每 60 秒的自采样本。
      // main 只取其中的 heap 作 scheduler 角色事件的 heap 维度，CPU 与 RSS 仍以 getAppMetrics 为准。
      type: "scheduler-resource-sample";
      sample: NodeSelfResourceSample;
    }
  | {
      // 本轮查询确认没有调度工作；wakeSeq 是查询前已收到的最大唤醒序号。
      // main 只在它等于自己发出的最新唤醒序号时让 scheduler 退出（host-idle-resources-1.1-spec §4）。
      type: "scheduler-idle";
      wakeSeq: number;
    };

/** main → scheduler */
export type MainToSchedulerMessage =
  | {
      type: "cron-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // main 在退出前通知 scheduler 优雅收尾（释放认领、关库）。
      type: "scheduler-dispose";
    }
  | {
      // 自动化定义或认领已提交，立即触发一次 tick；automationId 仅用于日志关联。
      // wakeSeq 由 main 单调递增分配，scheduler 在空闲报告中回带。
      type: "scheduler-wake";
      automationId: string;
      wakeSeq?: number;
    };
