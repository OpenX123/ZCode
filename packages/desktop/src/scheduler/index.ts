// 常驻 cron scheduler 进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 职责（tasks-index 属主方案）：
//   - 轮询 tasks-index 的 automations，事务认领到期任务（AutomationRepo.claimDue：BEGIN IMMEDIATE + running 0→1）
//   - 轮询 automation_runs 里的 manual run，手动触发累计 run_count，但不推进 next_run_at / max_runs / lifecycle
//   - 维护派发状态机：misfire 跳过、single-flight 认领、成功结算、失败退避重试
//   - 把到期任务的派发请求发回 main（main 再翻译成 CronRun 转给 workspace host 执行 createTask+sendPrompt）
//   - 收到 main 回报后结算 automation + automation_runs
// 本进程只读写 tasks-index，不碰 UI / agent runtime；createTask 由 host 域执行。
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationRun,
} from "@zcode/shared";
// 只导入类型：同目录保留着旧的 schedulerProtocol.js 编译产物，esbuild 会优先解析到它。
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { settleManualClaimForDispatchResult } from "./manualClaimRelease.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「关机/休眠/退出期间错过的窗口」→ 记 skipped 不补跑。
 * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

const { parentPort } = process;

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

const repo = new AutomationRepo();
/** runId → 在途派发上下文；等 main 回报后结算。scheduler 重启丢失时靠 claimDue 的僵尸回收兜底。 */
const inFlight = new Map<string, InFlight>();

let ticking = false;
let tickRequested = false;
/**
 * 已收到的最大唤醒序号（初值由 main 拉起时经环境变量传入）。空闲报告回带它，main 只在序号
 * 等于自己发出的最新唤醒时让本进程退出（docs/desktop/host-idle-resources-1.1-spec.md §4）。
 */
const initialWakeSeq = Number(process.env.ZCODE_SCHEDULER_WAKE_SEQ);
let latestWakeSeq =
  Number.isSafeInteger(initialWakeSeq) && initialWakeSeq >= 0 ? initialWakeSeq : 0;
let schedulerReady = false;
let disposed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 资源遥测：本进程唯一的自采定时器。 */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // 兜底：parentPort 不可用（非 utilityProcess 调试运行）时仍留痕。
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler 调试兜底
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

/** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

async function tick(): Promise<void> {
  if (disposed || !schedulerReady || ticking) return;
  ticking = true;
  try {
    do {
      tickRequested = false;
      try {
        const now = Date.now();
        const claimed = await repo.claimDue(now);
        for (const automation of claimed) {
          await handleClaimed(automation, now);
        }
        const manualRuns = await repo.claimManualRuns(now);
        for (const manualRun of manualRuns) {
          await handleClaimedManual(manualRun.automation, manualRun.run);
        }
      } catch (error) {
        log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 按需运行：本轮之后没有待处理唤醒时确认是否还有调度工作，没有就请 main 让本进程退出。
      // 修复原因（2026-11-08 本机扫描）：scheduler 112MB 无条件常驻，本机没有启用的自动化也一直在跑。
      if (!tickRequested && !disposed) await reportIdleIfNoWork();
      // manual run 的唤醒可能与当前 tick 重叠；因 ticking=true 直接丢弃会让
      // 用户仍需等待下一轮 20 秒轮询。记录 pending，并在本轮完成后立即补跑。
    } while (tickRequested && !disposed);
  } finally {
    ticking = false;
  }
}

/**
 * 先记下已收到的最大唤醒序号，再查询调度工作。Host 先提交再发唤醒，因此序号不大于该值的唤醒
 * 所对应的提交一定能被这次查询读到；之后到达的唤醒序号更大，main 会忽略这次空闲报告。
 * 有在途派发或库中仍有调度工作时不报告。
 */
async function reportIdleIfNoWork(): Promise<void> {
  try {
    if (inFlight.size > 0) return;
    const wakeSeq = latestWakeSeq;
    if (await repo.hasSchedulerWork()) return;
    if (disposed) return;
    const msg: SchedulerToMainMessage = { type: "scheduler-idle", wakeSeq };
    parentPort?.postMessage(msg);
  } catch (error) {
    // 查询失败按"仍有工作"处理：保持运行，下一轮再判定。
    log("warn", `idle check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requestTick(): void {
  if (disposed) return;
  if (!schedulerReady || ticking) {
    tickRequested = true;
    return;
  }
  void tick();
}

async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
  const scheduledAt = resolveScheduledAt(automation, now);
  const runId = buildRunId(automation.automationId, scheduledAt);
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });
  const isRetry = automation.dispatchAttempts > 0;

  // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
  const missed =
    !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
  if (missed) {
    // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
    // 通用重算会给出 anchorAt + k*interval 的下一周期，让“只跑一次”的提醒在后续周期
    // 继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
    const finalize = isOneShotAutomation(automation);
    const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
    await repo.skipAndReschedule({
      automationId: automation.automationId,
      runId,
      workspaceKey,
      scheduledAt,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt,
      finalize,
    });
    log(
      "info",
      `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
    );
    return;
  }

  // 正常派发：先落/更新 run 台账（claimed），再把请求发回 main。
  await repo.upsertRunClaimed({
    runId,
    automationId: automation.automationId,
    workspaceKey,
    scheduledAt,
    trigger: "schedule",
    // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
  });
  inFlight.set(runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "schedule",
  });
  const run = await repo.getRun(runId);
  postDispatchRequest(automation, runId, run?.modelSelection);
}

function postDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): void {
  const request: SchedulerToMainMessage = {
    type: "cron-dispatch-request",
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...((fixedSelection ?? automation.modelSelection)
      ? { modelSelection: fixedSelection ?? automation.modelSelection }
      : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    projectId: automation.projectId,
    hostId: automation.hostId,
    additionalDirectories: automation.additionalDirectories,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
}

async function handleClaimedManual(
  automation: ZCodeAutomation,
  run: ZCodeAutomationRun,
): Promise<void> {
  inFlight.set(run.runId, {
    automationId: automation.automationId,
    workspaceKey: resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    }),
    trigger: "manual",
  });
  postDispatchRequest(automation, run.runId, run.modelSelection);
}

async function settleDispatchResult(
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) => log("error", message),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  const kind = msg.failureKind ?? "transient";
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // transient 达上限后循环任务跳下一个正常 next_run_at。
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
  for (const [, context] of inFlight) {
    try {
      if (context.trigger === "manual") {
        await repo.releaseManualClaim(context.automationId, context.workspaceKey);
      } else {
        await repo.releaseClaim(context.automationId);
      }
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  inFlight.clear();
  try {
    repo.close();
  } catch {
    // 忽略。
  }
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    void settleDispatchResult(msg)
      .then(() => {
        // manual run 可能因同一 automation 已有派发在途而暂时无法认领。
        // 前一轮结算释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
        requestTick();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "scheduler-wake") {
    if (typeof msg.wakeSeq === "number" && msg.wakeSeq > latestWakeSeq) latestWakeSeq = msg.wakeSeq;
    log("info", `wake requested automation=${msg.automationId} wakeSeq=${latestWakeSeq}`);
    requestTick();
  }
});

async function main(): Promise<void> {
  await repo.ensureReady();
  schedulerReady = true;
  log("info", "cron scheduler started");
  requestTick();
  pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
  // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
