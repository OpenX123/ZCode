// W4：切换引擎到控件可见/可操作的埋点 `[engine-switch] controls ready {engine, source, ms}`。
// 同一次切换 cached 与 live 各记一次；切到 YCode 或旧引擎的快照不计。
import { describe, expect, it } from "vitest";
import { nextEngineSwitchReadyMark } from "@/hooks/external-engine/index.js";

const options = [{ id: "model" }];

describe("引擎切换就绪埋点（W4）", () => {
  it("cached 先记一次，ready 再记 live 并结束本次计时", () => {
    const pending = { engine: "claude-code" as const, startedAt: 100, logged: [] as string[] };
    const cached = nextEngineSwitchReadyMark(pending, {
      engine: "claude-code",
      optionCount: options.length,
      source: "cached",
      state: "connecting",
      now: 160,
    });
    expect(cached).toEqual({
      mark: { engine: "claude-code", source: "cached", ms: 60 },
      pending: { ...pending, logged: ["cached"] },
    });
    // 同一 cached 快照重复渲染不重复记。
    expect(
      nextEngineSwitchReadyMark(cached.pending, {
        engine: "claude-code",
        optionCount: 1,
        source: "cached",
        state: "connecting",
        now: 170,
      }),
    ).toEqual({ mark: undefined, pending: cached.pending });
    expect(
      nextEngineSwitchReadyMark(cached.pending, {
        engine: "claude-code",
        optionCount: 1,
        source: "live",
        state: "ready",
        now: 900,
      }),
    ).toEqual({ mark: { engine: "claude-code", source: "live", ms: 800 }, pending: undefined });
  });

  it("旧引擎快照、空清单与无计时都不记；缓存未命中时只记 live", () => {
    const pending = { engine: "codex" as const, startedAt: 0, logged: [] as string[] };
    expect(
      nextEngineSwitchReadyMark(pending, {
        engine: "claude-code",
        optionCount: 1,
        source: "live",
        state: "ready",
        now: 10,
      }).mark,
    ).toBeUndefined();
    expect(
      nextEngineSwitchReadyMark(pending, {
        engine: "codex",
        optionCount: 0,
        state: "connecting",
        now: 10,
      }).mark,
    ).toBeUndefined();
    expect(
      nextEngineSwitchReadyMark(undefined, {
        engine: "codex",
        optionCount: 1,
        state: "ready",
        now: 10,
      }).mark,
    ).toBeUndefined();
    expect(
      nextEngineSwitchReadyMark(pending, {
        engine: "codex",
        optionCount: 1,
        state: "ready",
        now: 420,
      }),
    ).toEqual({ mark: { engine: "codex", source: "live", ms: 420 }, pending: undefined });
  });
});
