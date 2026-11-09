import {
  isExternalSessionEngine,
  type ExternalSessionEngine,
  type SessionEngine,
  type ZCodeExternalEnginePrepareSpareParams,
} from "@zcode/shared";

/**
 * W4：窗口 Host 的外部引擎预热集合 =「Host 启动时的默认引擎」∪「本窗口选择过的外部引擎」，
 * 再过滤 launch 检查通过且有默认连接配置的引擎。Host 进程即窗口作用域，集合不跨窗口共享、不落盘。
 *
 * “选择过”的事实来自既有写入链：草稿切换引擎写 `defaultSessionEngine`，Host 经本进程设置提交通知观察；
 * Renderer 不新增上报接口。规则见 docs/desktop/external-agent-engines-spec.md「按引擎预热名额与缓存选项清单」。
 */
export interface ExternalEngineSpareSelectionDeps {
  readDefaultEngine(): Promise<SessionEngine | undefined>;
  /** 默认引擎设置提交后通知（Host 内 observable setting service）；返回取消订阅。 */
  onDefaultEngineChanged(listener: () => void): () => void;
  /** 只检查安装与路径，不启动 CLI；缺省视为就绪。 */
  isLaunchReady?(engine: ExternalSessionEngine): Promise<boolean>;
  readDefaultProfiles(): Promise<Partial<Record<ExternalSessionEngine, string>> | undefined>;
}

export interface ExternalEngineSpareSelection {
  /** 当前预热集合；当前默认引擎排在最前。 */
  select(): Promise<ZCodeExternalEnginePrepareSpareParams[]>;
  /** 集合扩大时通知（每个新引擎一次）；返回取消订阅。 */
  watch(onChange: () => void): () => void;
}

export function createExternalEngineSpareSelection(
  deps: ExternalEngineSpareSelectionDeps,
): ExternalEngineSpareSelection {
  const selected = new Set<ExternalSessionEngine>();
  const remember = (engine: SessionEngine | undefined): boolean => {
    if (!isExternalSessionEngine(engine) || selected.has(engine)) return false;
    selected.add(engine);
    return true;
  };
  return {
    async select() {
      const current = await deps.readDefaultEngine();
      remember(current);
      const ordered = [...selected].sort((left, right) =>
        left === current ? -1 : right === current ? 1 : 0,
      );
      const profiles = (await deps.readDefaultProfiles()) ?? {};
      const result: ZCodeExternalEnginePrepareSpareParams[] = [];
      for (const engine of ordered) {
        const connectionProfileId = profiles[engine];
        if (!connectionProfileId) continue;
        if (deps.isLaunchReady && !(await deps.isLaunchReady(engine))) continue;
        result.push({ engine, connectionProfileId });
      }
      return result;
    },
    watch(onChange) {
      return deps.onDefaultEngineChanged(() => {
        void deps
          .readDefaultEngine()
          .then((engine) => {
            if (remember(engine)) onChange();
          })
          .catch(() => {});
      });
    },
  };
}
