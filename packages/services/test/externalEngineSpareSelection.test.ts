// W4（P16）：Host 预热集合 = 启动默认引擎 ∪ 本窗口选择过的外部引擎，过滤 launch 就绪与默认连接配置。
// 规则见 docs/desktop/external-agent-engines-spec.md「按引擎预热名额与缓存选项清单」。
import { describe, expect, it, vi } from "vitest";
import type { SessionEngine } from "@zcode/shared";
import { createExternalEngineSpareSelection } from "../src/external-engine/node.js";

function harness(initial: SessionEngine, ready: Partial<Record<string, boolean>> = {}) {
  let engine: SessionEngine = initial;
  const listeners = new Set<() => void>();
  const selection = createExternalEngineSpareSelection({
    readDefaultEngine: async () => engine,
    onDefaultEngineChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isLaunchReady: async (candidate) => ready[candidate] ?? true,
    readDefaultProfiles: async () => ({ codex: "inherit", "claude-code": "official" }),
  });
  return {
    selection,
    choose(next: SessionEngine) {
      engine = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("外部引擎预热集合（W4）", () => {
  it("启动默认引擎先预热；选择新外部引擎后集合扩大并通知一次", async () => {
    const { selection, choose } = harness("codex");
    expect(await selection.select()).toEqual([{ engine: "codex", connectionProfileId: "inherit" }]);
    const onChange = vi.fn();
    const stop = selection.watch(onChange);
    choose("claude-code");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    // 当前默认引擎排在前面，集合保留此前选择过的 Codex。
    expect(await selection.select()).toEqual([
      { engine: "claude-code", connectionProfileId: "official" },
      { engine: "codex", connectionProfileId: "inherit" },
    ]);
    choose("zcode");
    choose("codex");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("YCode 默认时不预热；launch 未就绪的引擎被过滤；取消订阅后不再通知", async () => {
    const { selection, choose, listenerCount } = harness("zcode", { "claude-code": false });
    expect(await selection.select()).toEqual([]);
    const onChange = vi.fn();
    const stop = selection.watch(onChange);
    choose("claude-code");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await selection.select()).toEqual([]);
    stop();
    expect(listenerCount()).toBe(0);
    choose("codex");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
