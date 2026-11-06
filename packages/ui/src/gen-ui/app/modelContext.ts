import type { IGenUiService } from "@zcode/services";
import {
  buildGenUiModelContext,
  buildGenUiScopeKey,
  type GenUiScope,
  type GenUiStateEntry,
} from "@zcode/shared/gen-ui";

export interface GenUiModelContextReader {
  /** 生成下一轮的不可信 widget 上下文；缓存命中时不发 IPC，读取失败交给调用方降级。 */
  read(scope: GenUiScope): Promise<string>;
  dispose(): void;
}

/**
 * 1.1 Renderer 发送路径：过去每次 sendText 都向 Desktop Host 发一次 listState。状态仍只归
 * Host 存储所有；这里只按 scope 缓存最近一次读取，任何同 scope 的 onStateChanged 都使其失效，
 * 读取与变更重叠时结果只用于本次发送、不入缓存。见 docs/desktop/engine-performance-1.1-spec.md。
 */
export function createGenUiModelContextReader(
  state: Pick<IGenUiService, "listState" | "onStateChanged">,
): GenUiModelContextReader {
  const cache = new Map<string, readonly GenUiStateEntry[]>();
  const generations = new Map<string, number>();
  let disposed = false;
  const subscription = state.onStateChanged((change) => {
    const key = buildGenUiScopeKey(change.target);
    cache.delete(key);
    generations.set(key, (generations.get(key) ?? 0) + 1);
  });
  return {
    async read(scope) {
      const key = buildGenUiScopeKey(scope);
      const cached = cache.get(key);
      if (cached) return buildGenUiModelContext(cached);
      const generation = generations.get(key) ?? 0;
      const entries = await state.listState(scope);
      if (!disposed && (generations.get(key) ?? 0) === generation) cache.set(key, entries);
      return buildGenUiModelContext(entries);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      subscription.dispose();
      cache.clear();
      generations.clear();
    },
  };
}
