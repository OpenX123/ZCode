import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillsHubServicePort } from "@/settings/skills-hub/index.js";
import type { SkillsHubState } from "@zcode/shared/skills-hub";
import { logger } from "@/logger.js";

export interface SkillsHubController {
  state: SkillsHubState | null;
  busy: boolean;
  error: string | null;
  sync: () => void;
  prune: (entryNames: string[]) => void;
  choose: (nameKey: string, realDir: string | null) => void;
  dismissNew: () => void;
}

export type SkillsHubCommandKind = "sync" | "prune" | "choose" | "dismiss";

type HubService = SkillsHubServicePort;

/**
 * Skills Hub 状态的唯一 UI 读取入口：打开（enabled）时同步一次；命令返回值与 onDidChangeHub
 * 事件都整体替换状态，不在 UI 侧合并出第二份事实。只采用最新一次请求的结果，避免旧结果回填。
 */
export function useSkillsHub(options: {
  skillsService: HubService | null | undefined;
  enabled: boolean;
  /** Hub 改变了技能目录后通知调用方刷新列表、共享技能 store 与草稿 runtime。 */
  onChanged?: (kind: SkillsHubCommandKind, changed: boolean) => void | Promise<void>;
}): SkillsHubController {
  const { skillsService, enabled } = options;
  const [state, setState] = useState<SkillsHubState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const onChangedRef = useRef(options.onChanged);
  useEffect(() => {
    onChangedRef.current = options.onChanged;
  }, [options.onChanged]);

  const run = useCallback(
    (kind: SkillsHubCommandKind, task: (service: HubService) => Promise<SkillsHubState>) => {
      if (!skillsService || !enabled) return;
      const seq = ++requestSeqRef.current;
      setBusy(true);
      setError(null);
      task(skillsService)
        .then(async (next) => {
          if (seq !== requestSeqRef.current) return;
          setState(next);
          setBusy(false);
          // 普通同步没有新建/删除链接时技能目录未变，不必刷新列表与草稿 runtime。
          const changed = kind !== "sync" || next.createdCount > 0 || next.removedCount > 0;
          await onChangedRef.current?.(kind, changed);
        })
        .catch((cause: unknown) => {
          if (seq !== requestSeqRef.current) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          logger.warn("[useSkillsHub] 外部技能同步命令失败", { error: message });
          setError(message);
          setBusy(false);
        });
    },
    [enabled, skillsService],
  );

  useEffect(() => {
    if (!enabled || !skillsService) {
      setState(null);
      return;
    }
    // 决策 7：打开技能设置页时同步一次。
    run("sync", (service) => service.syncHub());
  }, [enabled, run, skillsService]);

  useEffect(() => {
    if (!enabled || !skillsService || typeof skillsService.onDidChangeHub !== "function") return;
    const subscription = skillsService.onDidChangeHub((next) => {
      // 其他入口（启动同步、另一窗口）完成的同步也直接替换当前状态。
      setState(next);
    });
    return () => subscription.dispose();
  }, [enabled, skillsService]);

  return {
    state,
    busy,
    error,
    sync: () => run("sync", (service) => service.syncHub()),
    prune: (entryNames) => run("prune", (service) => service.pruneHubLinks({ entryNames })),
    choose: (nameKey, realDir) =>
      run("choose", (service) => service.setHubConflictChoice({ nameKey, realDir })),
    dismissNew: () => run("dismiss", (service) => service.dismissHubDiscoveries()),
  };
}
