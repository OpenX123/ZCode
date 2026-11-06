// 按外部引擎记忆最近确认的模型与思考深度（docs/desktop/external-agent-engines-spec.md
// “按引擎记忆模型与思考深度”）。Runtime 仍是已确认配置的唯一所有者：这里只在 snapshot
// 确认用户显式选择后写本机偏好，并在新草稿原生配置就绪后经既有命令链路恢复。
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  engineConfigOptionKind,
  isExternalSessionEngine,
  type EngineConfigOption,
  type ExternalEngineConfigPreferences,
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
  value: string;
}

interface RestoreRun {
  sessionId: string;
  remembered: Readonly<Record<string, string>> | undefined;
  settled: Set<string>;
  awaiting?: EngineConfigRestoreStep;
  inFlight: boolean;
  stopped: boolean;
}

export interface EngineConfigMemoryParams {
  engine: SessionEngine;
  /** snapshot 所属会话（草稿为预热会话）；null 表示还没有原生配置。 */
  sessionId: string | null;
  /** snapshot 已确认的原生配置；连接未 ready 或引擎不一致时为 undefined。 */
  options: readonly EngineConfigOption[] | undefined;
  /** 仅本生命周期新固定外部引擎的草稿为 true；已有草稿与已创建会话不恢复。 */
  restoreEnabled: boolean;
  /** 复用既有 configCommandBarrier → setEngineConfigOption 链路；返回是否被接受。 */
  applyOption: (sessionId: string, configId: string, value: string) => Promise<boolean>;
}

export interface EngineConfigMemory {
  /** 用户显式修改被接受后调用；snapshot 确认为所选值后才写入本机记忆。 */
  recordExplicitChange: (configId: string, value: string) => void;
}

export function useEngineConfigMemory(params: EngineConfigMemoryParams): EngineConfigMemory {
  const { engine, sessionId, options, restoreEnabled, applyOption } = params;
  // 设备偏好只写本机 Host，远端工作区也不写远端设置（与 defaultSessionEngine 同一所有者）。
  const services = useBaseWorkspaceServices();
  const { settings, loading, update } = useSettings({ services });
  const [recheckVersion, recheck] = useReducer((value: number) => value + 1, 0);
  const latest = useRef({ engine, sessionId, options, settings, update });
  latest.current = { engine, sessionId, options, settings, update };
  const pending = useRef(new Map<string, PendingConfirmation>());
  const restore = useRef<RestoreRun | null>(null);

  const confirmPending = useCallback(() => {
    const current = latest.current;
    for (const [configId, entry] of pending.current) {
      // 会话或引擎已切换：该次选择的确认值不会再出现在当前 snapshot。
      if (entry.sessionId !== current.sessionId || entry.engine !== current.engine) {
        pending.current.delete(configId);
        continue;
      }
      const option = current.options?.find((candidate) => candidate.id === configId);
      // 引擎拒绝或改用其它值时 snapshot 不会出现所选值，不写入记忆。
      if (option?.currentValue !== entry.value) continue;
      pending.current.delete(configId);
      const remembered = current.settings?.externalEngineConfigPreferences?.[entry.engine];
      if (remembered?.[configId] === entry.value) continue;
      // 只提交确认的增量，设置服务在写队列内按引擎与 configId 合并。
      const patch: ExternalEngineConfigPreferences = {};
      patch[entry.engine] = { [configId]: entry.value };
      void current.update({ externalEngineConfigPreferences: patch }).catch((error: unknown) => {
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
  }, [confirmPending, engine, sessionId, options]);

  const recordExplicitChange = useCallback(
    (configId: string, value: string) => {
      const current = latest.current;
      if (
        !current.sessionId ||
        !isExternalSessionEngine(current.engine) ||
        engineConfigOptionKind(configId) === "other"
      )
        return;
      // 用户已接管本会话的配置：停止（或预先阻止）恢复，避免覆盖其显式选择。
      if (restore.current?.sessionId === current.sessionId) restore.current.stopped = true;
      else
        restore.current = {
          sessionId: current.sessionId,
          remembered: undefined,
          settled: new Set(),
          inFlight: false,
          stopped: true,
        };
      pending.current.set(configId, {
        sessionId: current.sessionId,
        engine: current.engine,
        value,
      });
      // snapshot 可能先于 ACK 到达；立即按当前确认值检查一次。
      confirmPending();
    },
    [confirmPending],
  );

  useEffect(() => {
    if (!restoreEnabled || !sessionId || !options || !isExternalSessionEngine(engine)) return;
    // 本机设置尚在首次读取时等待，不能把“未读到”当成“没有记忆”。
    if (!settings && loading) return;
    if (restore.current?.sessionId !== sessionId) {
      // 每个预热会话只恢复一次，并冻结就绪时的记忆，之后的偏好变化不重配已打开的草稿。
      restore.current = {
        sessionId,
        remembered: settings?.externalEngineConfigPreferences?.[engine],
        settled: new Set(),
        inFlight: false,
        stopped: false,
      };
    }
    const run = restore.current;
    if (run.stopped || run.inFlight) return;
    const awaiting = run.awaiting;
    if (awaiting) {
      const option = options.find((candidate) => candidate.id === awaiting.configId);
      // 等 snapshot 确认上一项后再判断下一项（模型切换会刷新深度目录）。
      if (option?.currentValue !== awaiting.value) return;
      run.settled.add(awaiting.configId);
      run.awaiting = undefined;
    }
    const step = nextEngineConfigRestoreStep(options, run.remembered, run.settled);
    if (!step) {
      run.stopped = true;
      return;
    }
    run.inFlight = true;
    void applyOption(sessionId, step.configId, step.value)
      .catch(() => false)
      .then((accepted) => {
        if (restore.current !== run) return;
        run.inFlight = false;
        if (accepted) run.awaiting = step;
        else run.settled.add(step.configId);
        // ACK 可能晚于 snapshot 到达；收口后主动复查一次当前确认值。
        recheck();
      });
  }, [restoreEnabled, sessionId, options, engine, settings, loading, applyOption, recheckVersion]);

  return { recordExplicitChange };
}
