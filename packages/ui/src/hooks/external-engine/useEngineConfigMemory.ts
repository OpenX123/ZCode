// 按外部引擎与连接记忆最近确认的模型与思考深度（docs/desktop/external-agent-engines-spec.md
// “按引擎与连接记忆模型与思考深度”）。Runtime 仍是已确认配置的唯一所有者：这里只在 snapshot
// 确认用户显式选择后写本机偏好，并在新草稿原生配置就绪后经既有命令链路恢复；恢复的逐项推进
// 以命令 ACK 带回的 runtime 确认配置为准，不等 snapshot 帧。
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  engineConfigOptionKind,
  isExternalSessionEngine,
  resolveEngineConnectionProfileId,
  type EngineConfigOption,
  type ExternalEngineConnectionConfigPreferences,
  type ExternalSessionEngine,
  type SessionEngine,
} from "@zcode/shared/external-engine";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/** 恢复顺序：深度目录随模型变化，必须在模型确认后再按新目录判断。 */
const RESTORE_ORDER = ["model", "effort"] as const;

export interface EngineConfigRestoreStep {
  configId: string;
  value: string;
}

/**
 * 下一项需要恢复的原生配置；值不在当前目录、已是当前值或已处理过的配置项跳过。
 * 纯函数，只读 snapshot 目录与记忆，不产生配置写入。
 */
export function nextEngineConfigRestoreStep(
  options: readonly EngineConfigOption[],
  remembered: Readonly<Record<string, string>> | undefined,
  settled: ReadonlySet<string> = new Set(),
): EngineConfigRestoreStep | null {
  if (!remembered) return null;
  for (const kind of RESTORE_ORDER) {
    const option = options.find((entry) => engineConfigOptionKind(entry.id) === kind);
    if (!option || settled.has(option.id)) continue;
    const value = remembered[option.id];
    if (!value || value === option.currentValue) continue;
    if (!option.options.some((entry) => entry.value === value)) continue;
    return { configId: option.id, value };
  }
  return null;
}

interface PendingConfirmation {
  sessionId: string;
  engine: ExternalSessionEngine;
  connectionProfileId: string;
  value: string;
}

interface RestoreRun {
  sessionId: string;
  connectionProfileId?: string;
  remembered: Readonly<Record<string, string>> | undefined;
  settled: Set<string>;
  /** 恢复循环已启动；每个预热会话只跑一次。 */
  started: boolean;
  stopped: boolean;
}

/** 一项恢复命令的结果：被拒（含失败、未发出）为 null。 */
export interface EngineConfigApplyResult {
  /** CLI 在 ACK 中带回的 runtime 确认配置；noop 或旧 CLI 不带时缺省。 */
  confirmedOptions?: readonly EngineConfigOption[];
}

interface RestoreWaiter {
  sessionId: string;
  resolve: () => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

export interface EngineConfigMemoryParams {
  engine: SessionEngine;
  /** snapshot 的绑定 ID；旧 snapshot 缺省时 resolver 回退，null 表示当前绑定尚未就绪。 */
  connectionProfileId?: string | null;
  /** snapshot 所属会话（草稿为预热会话）；null 表示还没有原生配置。 */
  sessionId: string | null;
  /** snapshot 已确认的原生配置；连接未 ready 或引擎不一致时为 undefined。 */
  options: readonly EngineConfigOption[] | undefined;
  /** 仅本生命周期新固定外部引擎的草稿为 true；已有草稿与已创建会话不恢复。 */
  restoreEnabled: boolean;
  /**
   * 复用既有 configCommandBarrier → setEngineConfigOption 链路；被拒返回 null，接受时返回 ACK
   * 带回的确认配置（见 EngineConfigApplyResult）。
   */
  applyOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<EngineConfigApplyResult | null>;
}

export interface EngineConfigMemory {
  /** 用户显式修改被接受后调用；snapshot 确认为所选值后才写入本机记忆。 */
  recordExplicitChange: (
    configId: string,
    value: string,
    scope?: { sessionId: string; connectionProfileId: string | null | undefined },
  ) => void;
  /**
   * 首发前等待该预热会话的记忆恢复收口：全部恢复项确认、无可恢复项、用户接管，或引擎改用其它值
   * / 保留旧值（以 ACK 确认值判定）。
   * 恢复尚未开始（snapshot 未 ready、设置未读到）时继续等待，因此只对可恢复记忆的草稿调用。
   * 恢复命令经调用方的配置屏障下发：调用方必须在屏障外等待，否则与恢复命令互等死锁。
   * signal 中止、恢复开始后连接不再就绪或 hook 卸载时拒绝。
   */
  waitForRestore: (sessionId: string, signal?: AbortSignal) => Promise<void>;
}

export function useEngineConfigMemory(params: EngineConfigMemoryParams): EngineConfigMemory {
  const { engine, sessionId, options, restoreEnabled, applyOption } = params;
  const connectionProfileId =
    params.connectionProfileId === null || !isExternalSessionEngine(engine)
      ? null
      : resolveEngineConnectionProfileId(undefined, {
          engine,
          connectionProfileId: params.connectionProfileId,
        });
  // 设备偏好只写本机 Host，远端工作区也不写远端设置（与 defaultSessionEngine 同一所有者）。
  const services = useBaseWorkspaceServices();
  const { settings, loading, update } = useSettings({ services });
  const latest = useRef({
    engine,
    sessionId,
    connectionProfileId,
    options,
    settings,
    update,
    applyOption,
  });
  latest.current = {
    engine,
    sessionId,
    connectionProfileId,
    options,
    settings,
    update,
    applyOption,
  };
  const pending = useRef(new Map<string, PendingConfirmation>());
  const restore = useRef<RestoreRun | null>(null);
  const waiters = useRef(new Set<RestoreWaiter>());
  const unmounted = useRef(false);

  /** 按当前恢复进度收口首发等待者（见 EngineConfigMemory.waitForRestore）。 */
  const settleWaiters = useCallback(() => {
    const run = restore.current;
    const current = latest.current;
    const interrupted = Boolean(
      run?.started &&
      current.sessionId === run.sessionId &&
      (!current.options || current.connectionProfileId === null),
    );
    // 断连会令在途 ACK 的身份校验提前退出，不能遗留 started=true/stopped=false 的无执行者轮次。
    // 由同一 owner 在断连时终结本轮；当前首发仍失败，重连后的再次发送可沿用已确认配置。
    if (interrupted && run) run.stopped = true;
    for (const waiter of waiters.current) {
      if (run?.sessionId !== waiter.sessionId) continue;
      if (interrupted) {
        // 恢复已开始而连接不再就绪（adapter 退出或断联）：恢复无法在首发前完成，首发按失败处理，
        // 由发送链抛错保留输入，草稿显示原错误与“重新连接”。
        waiters.current.delete(waiter);
        waiter.detach();
        waiter.reject(new Error("引擎连接已中断，请重新连接后发送"));
      } else if (run.stopped) {
        waiters.current.delete(waiter);
        waiter.detach();
        waiter.resolve();
      }
    }
  }, []);

  const confirmPending = useCallback(() => {
    const current = latest.current;
    for (const [configId, entry] of pending.current) {
      // 会话或引擎已切换：该次选择的确认值不会再出现在当前 snapshot。
      if (
        entry.sessionId !== current.sessionId ||
        entry.engine !== current.engine ||
        entry.connectionProfileId !== current.connectionProfileId
      ) {
        pending.current.delete(configId);
        continue;
      }
      const option = current.options?.find((candidate) => candidate.id === configId);
      // 引擎拒绝或改用其它值时 snapshot 不会出现所选值，不写入记忆。
      if (option?.currentValue !== entry.value) continue;
      pending.current.delete(configId);
      const remembered =
        current.settings?.externalEngineConnectionConfigPreferences?.[entry.engine]?.[
          entry.connectionProfileId
        ];
      if (remembered?.[configId] === entry.value) continue;
      // 只提交确认的增量，设置服务在写队列内按引擎、连接与 configId 合并。
      const patch: ExternalEngineConnectionConfigPreferences = {};
      patch[entry.engine] = { [entry.connectionProfileId]: { [configId]: entry.value } };
      void current
        .update({ externalEngineConnectionConfigPreferences: patch })
        .catch((error: unknown) => {
          logger.warn("[external-engine] 引擎配置记忆保存失败", {
            engine: entry.engine,
            configId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }, []);

  useEffect(() => {
    confirmPending();
  }, [confirmPending, engine, sessionId, connectionProfileId, options]);

  const recordExplicitChange = useCallback(
    (
      configId: string,
      value: string,
      scope?: { sessionId: string; connectionProfileId: string | null | undefined },
    ) => {
      const current = latest.current;
      if (
        !current.sessionId ||
        !current.connectionProfileId ||
        (scope &&
          (scope.sessionId !== current.sessionId ||
            scope.connectionProfileId === null ||
            resolveEngineConnectionProfileId(undefined, {
              engine: current.engine as ExternalSessionEngine,
              connectionProfileId: scope.connectionProfileId,
            }) !== current.connectionProfileId)) ||
        !isExternalSessionEngine(current.engine) ||
        engineConfigOptionKind(configId) === "other"
      )
        return;
      // 用户已接管本会话的配置：停止（或预先阻止）恢复，避免覆盖其显式选择。
      if (restore.current?.sessionId === current.sessionId) restore.current.stopped = true;
      else
        restore.current = {
          sessionId: current.sessionId,
          connectionProfileId: current.connectionProfileId,
          remembered: undefined,
          settled: new Set(),
          started: true,
          stopped: true,
        };
      // 用户的配置命令同样经配置屏障，排在随后入队的首发之前；等待恢复的首发可以继续。
      settleWaiters();
      pending.current.set(configId, {
        sessionId: current.sessionId,
        engine: current.engine,
        connectionProfileId: current.connectionProfileId,
        value,
      });
      // snapshot 可能先于 ACK 到达；立即按当前确认值检查一次。
      confirmPending();
    },
    [confirmPending, settleWaiters],
  );

  /**
   * 恢复循环：逐项经 applyOption（配置屏障 → setEngineConfigOption）下发，并以 ACK 带回的 runtime
   * 确认配置推进下一项（模型确认后的新深度目录也来自该结果）。
   * 修复依据（2026-11-08）：旧逻辑在 ACK 后等 snapshot 出现所选值才推进。引擎接受却原样保留旧值时，
   * runtime 只再发布一次相同配置、之后没有新帧，“确认尚未回流”与“引擎保留旧值”无法区分，等待恢复
   * 收口的草稿首发会永远“正在发送”。ACK 结果是确定的，不依赖帧到达时序；snapshot 仍只用于界面
   * 显示与记忆写入（confirmPending）。
   */
  const runRestore = useCallback(
    async (run: RestoreRun, initialOptions: readonly EngineConfigOption[]) => {
      const isCurrent = () =>
        restore.current === run &&
        !unmounted.current &&
        latest.current.sessionId === run.sessionId &&
        latest.current.connectionProfileId === run.connectionProfileId;
      let catalog = initialOptions;
      while (isCurrent() && !run.stopped) {
        const step = nextEngineConfigRestoreStep(catalog, run.remembered, run.settled);
        if (!step) break;
        const result = await latest.current
          .applyOption(run.sessionId, step.configId, step.value)
          .catch(() => null);
        // 会话已切换或卸载：本轮作废；用户接管时等待者已在 recordExplicitChange 中收口。
        if (!isCurrent() || run.stopped) return;
        run.settled.add(step.configId);
        if (!result?.confirmedOptions) {
          // 被拒（该项不重试，值未变），或 noop / 旧 CLI 不带确认配置（视为已是当前值）：
          // 按最新 snapshot 目录判断下一项，连接未就绪时沿用本轮目录。
          catalog = latest.current.options ?? catalog;
          continue;
        }
        const confirmed = result.confirmedOptions;
        // 引擎改用其它值或原样保留旧值：所选值未被确认，不再按未确认的目录恢复后续项。
        if (confirmed.find((option) => option.id === step.configId)?.currentValue !== step.value)
          break;
        catalog = confirmed;
      }
      if (!isCurrent()) return;
      run.stopped = true;
      settleWaiters();
    },
    [settleWaiters],
  );

  useEffect(() => {
    if (
      !restoreEnabled ||
      !sessionId ||
      !connectionProfileId ||
      !options ||
      !isExternalSessionEngine(engine)
    )
      return;
    // 本机设置尚在首次读取时等待，不能把“未读到”当成“没有记忆”。
    if (!settings && loading) return;
    if (
      restore.current?.sessionId !== sessionId ||
      restore.current.connectionProfileId !== connectionProfileId
    ) {
      // 每个预热会话只恢复一次，并冻结就绪时的记忆，之后的偏好变化不重配已打开的草稿。
      restore.current = {
        sessionId,
        connectionProfileId,
        remembered:
          settings?.externalEngineConnectionConfigPreferences?.[engine]?.[connectionProfileId] ??
          settings?.externalEngineConfigPreferences?.[engine],
        settled: new Set(),
        started: false,
        stopped: false,
      };
    }
    const run = restore.current;
    if (run.started || run.stopped) return;
    run.started = true;
    void runRestore(run, options);
  }, [
    restoreEnabled,
    sessionId,
    connectionProfileId,
    options,
    engine,
    settings,
    loading,
    runRestore,
  ]);

  // 连接就绪状态变化时复查等待者（恢复开始后连接不再就绪即拒绝）；恢复推进由 runRestore 收口。
  useEffect(() => {
    settleWaiters();
  }, [settleWaiters, sessionId, connectionProfileId, options]);

  useEffect(() => {
    unmounted.current = false;
    const pendingWaiters = waiters.current;
    return () => {
      unmounted.current = true;
      for (const waiter of pendingWaiters) {
        waiter.detach();
        waiter.reject(new Error("草稿已关闭，请重新发送"));
      }
      pendingWaiters.clear();
    };
  }, []);

  const waitForRestore = useCallback(
    (targetSessionId: string, signal?: AbortSignal) => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const run = restore.current;
      if (
        run?.sessionId === targetSessionId &&
        run.stopped &&
        latest.current.sessionId === targetSessionId &&
        latest.current.options &&
        latest.current.connectionProfileId
      )
        return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          if (!waiters.current.delete(waiter)) return;
          reject(signal?.reason);
        };
        const waiter: RestoreWaiter = {
          sessionId: targetSessionId,
          resolve,
          reject,
          detach: () => signal?.removeEventListener("abort", onAbort),
        };
        waiters.current.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        settleWaiters();
      });
    },
    [settleWaiters],
  );

  return useMemo(
    () => ({ recordExplicitChange, waitForRestore }),
    [recordExplicitChange, waitForRestore],
  );
}
