import { useMemo, useRef } from "react";
import type {
  BackgroundWorkSummary,
  SubagentProjectionState,
} from "@zcode/shared/zcode-protocol-v4";
import type { SubagentWorkLiveIndex } from "./contract.js";
import { buildSubagentWorkLiveIndex, sameSubagentWorkLiveIndex } from "./model.js";

/**
 * 工作卡读取的父会话运行态索引（waiting / blocked 与可停 workId）。
 *
 * 父会话每次投影（含子工具计步带来的 running[] 更新）都会换新数组；这里只在索引内容变化时
 * 才换引用，SessionPane 的行 context 因此不会因计步而让整条时间线重渲染。
 */
export function useSubagentWorkLiveIndex(
  subagents: SubagentProjectionState | null | undefined,
  backgroundWorks: readonly BackgroundWorkSummary[] | null | undefined,
): SubagentWorkLiveIndex {
  const next = useMemo(
    () => buildSubagentWorkLiveIndex(subagents, backgroundWorks),
    [backgroundWorks, subagents],
  );
  const stable = useRef(next);
  if (stable.current !== next && !sameSubagentWorkLiveIndex(stable.current, next)) {
    stable.current = next;
  }
  return stable.current;
}
