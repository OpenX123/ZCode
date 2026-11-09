// 外部引擎选项清单缓存（W4）：每个 CLI 进程一个，只在内存保存“上次握手确认的 engineConfigOptions”。
//
// - 键 =（引擎，解析后的连接配置 ID，工作区身份 key，内部 generation）；generation 覆盖配置、凭据与
//   启动环境，任一变化都不命中，避免把别的身份下的目录展示给新会话。generation 不出 adapter。
// - 只服务“新草稿 connecting 时先显示控件”：命中结果经会话输入交给 Runtime 作为展示副本，Runtime
//   仍是选项清单唯一所有者；不落盘、不参与配置恢复。
// 规则见 docs/desktop/external-agent-engines-spec.md「按引擎预热名额与缓存选项清单」。
import type { EngineConfigOption, ExternalSessionEngine } from "@zcode/shared";

export interface ExternalEngineConfigCatalogKey {
  engine: ExternalSessionEngine;
  connectionProfileId: string;
  /** `workspaceIdentity?.trim() || workspacePath`；缺省由 port 回落到会话 cwd。 */
  workspaceKey: string;
  generation: string;
}

export interface ExternalEngineConfigCatalog {
  lookup(key: ExternalEngineConfigCatalogKey): EngineConfigOption[] | undefined;
  remember(key: ExternalEngineConfigCatalogKey, options: readonly EngineConfigOption[]): void;
}

export const EXTERNAL_ENGINE_CONFIG_CATALOG_MAX_ENTRIES = 16;

const catalogKey = (key: ExternalEngineConfigCatalogKey) =>
  JSON.stringify([key.engine, key.connectionProfileId, key.workspaceKey, key.generation]);

export function createExternalEngineConfigCatalog(
  options: { maxEntries?: number } = {},
): ExternalEngineConfigCatalog {
  const maxEntries = Math.max(1, options.maxEntries ?? EXTERNAL_ENGINE_CONFIG_CATALOG_MAX_ENTRIES);
  // Map 保持插入序：命中或写入时移到末尾，超过上限淘汰最旧条目。
  const entries = new Map<string, EngineConfigOption[]>();
  return {
    lookup(key) {
      const id = catalogKey(key);
      const value = entries.get(id);
      if (!value) return undefined;
      entries.delete(id);
      entries.set(id, value);
      return structuredClone(value);
    },
    remember(key, list) {
      // 空目录不是有效的“上次清单”，不覆盖已有条目。
      if (list.length === 0) return;
      const id = catalogKey(key);
      entries.delete(id);
      entries.set(id, structuredClone([...list]));
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
