import { useCallback, useEffect, useRef } from "react";
import type { EngineConfigState, ExternalSessionEngine, SessionEngine } from "@zcode/shared";
import { isExternalSessionEngine } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * W4 埋点：从草稿切换外部引擎开始计时，到该引擎控件可见（cached）与可操作（live）各记一次
 * `[engine-switch] controls ready {engine, source, ms}`。只读快照派生，不缓存选项清单。
 * 规则见 docs/desktop/external-agent-engines-spec.md「按引擎预热名额与缓存选项清单」。
 */
export interface EngineSwitchPending {
  engine: ExternalSessionEngine;
  startedAt: number;
  logged: readonly string[];
}

export interface EngineSwitchObservation {
  /** 当前快照所属引擎。 */
  engine: SessionEngine | undefined;
  optionCount: number;
  source?: "cached" | "live";
  state: EngineConfigState | undefined;
  now: number;
}

export interface EngineSwitchReadyMark {
  engine: ExternalSessionEngine;
  source: "cached" | "live";
  ms: number;
}

export function nextEngineSwitchReadyMark(
  pending: EngineSwitchPending | undefined,
  observed: EngineSwitchObservation,
): { mark: EngineSwitchReadyMark | undefined; pending: EngineSwitchPending | undefined } {
  if (!pending || observed.engine !== pending.engine || observed.optionCount === 0)
    return { mark: undefined, pending };
  const ms = Math.max(0, Math.round(observed.now - pending.startedAt));
  if (observed.state === "ready")
    return { mark: { engine: pending.engine, source: "live", ms }, pending: undefined };
  if (observed.source === "cached" && !pending.logged.includes("cached"))
    return {
      mark: { engine: pending.engine, source: "cached", ms },
      pending: { ...pending, logged: [...pending.logged, "cached"] },
    };
  return { mark: undefined, pending };
}

export function useEngineSwitchReadyMarker(observed: Omit<EngineSwitchObservation, "now">): {
  markEngineSwitch(engine: SessionEngine): void;
} {
  const pendingRef = useRef<EngineSwitchPending | undefined>(undefined);
  const markEngineSwitch = useCallback((engine: SessionEngine) => {
    pendingRef.current = isExternalSessionEngine(engine)
      ? { engine, startedAt: performance.now(), logged: [] }
      : undefined;
  }, []);
  const { engine, optionCount, source, state } = observed;
  useEffect(() => {
    const next = nextEngineSwitchReadyMark(pendingRef.current, {
      engine,
      optionCount,
      source,
      state,
      now: performance.now(),
    });
    pendingRef.current = next.pending;
    // 一次切换至多两条，生产包也保留（lifecycle），用于本机日志验收 ≤100ms / ≤1s。
    if (next.mark) logger.lifecycle.info("[engine-switch] controls ready", next.mark);
  }, [engine, optionCount, source, state]);
  return { markEngineSwitch };
}
