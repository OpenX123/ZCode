// W4（P17）：新草稿 connecting 时 Runtime 先发布缓存清单（source=cached），确认后替换为 live。
// 规则见 docs/desktop/external-agent-engines-spec.md「按引擎预热名额与缓存选项清单」。
import { describe, expect, test } from "vitest";
import { createRootTraceContext, type ExternalEngineSessionInput } from "@zcode/contracts";
import type { EngineConfigOption } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { prepareExternalEngineSession } from "../src/external-engine/session.js";
import { setup } from "./helpers/external-engine-runtime.js";

const option = (currentValue: string): EngineConfigOption => ({
  id: "model",
  name: "Model",
  currentValue,
  options: [
    { value: "cached-model", name: "Cached" },
    { value: "live-model", name: "Live" },
  ],
});

function configEvents(events: Record<string, unknown>[]) {
  return events
    .filter((event) => event.type === "external_engine.config_updated" || "payload" in event)
    .map((event) => event.payload as Record<string, unknown>)
    .filter((payload) => payload && "engineConfigState" in payload)
    .map((payload) => ({
      state: payload.engineConfigState,
      source: payload.engineConfigOptionsSource,
      values: (payload.engineConfigOptions as EngineConfigOption[]).map(
        (item) => item.currentValue,
      ),
    }));
}

function withPort(
  runtime: AgentRuntimeInternal,
  prepare: (input: ExternalEngineSessionInput) => Promise<void>,
) {
  (runtime as unknown as { externalEnginePort: { prepareSession: typeof prepare } })
    .externalEnginePort.prepareSession = prepare;
  (runtime.config as Record<string, unknown>).workspacePath = "/workspace";
  (runtime.config as Record<string, unknown>).workspaceIdentity = " local:workspace ";
}

describe("外部引擎缓存选项清单（W4）", () => {
  test("connecting 先发布缓存清单，确认后替换为 live；缓存不进入 Runtime 真值", async () => {
    const { runtime, events } = setup([]);
    let seenWorkspaceKey: string | undefined;
    let valuesDuringCached: string[] = [];
    withPort(runtime, async (input) => {
      seenWorkspaceKey = input.workspaceKey;
      await input.onCachedConfigOptions?.([option("cached-model")]);
      valuesDuringCached = runtime.engineConfigOptions.map((item) => item.currentValue);
      await input.onConfigOptions([option("live-model")]);
    });
    await prepareExternalEngineSession(runtime, createRootTraceContext());
    expect(seenWorkspaceKey).toBe("local:workspace");
    expect(valuesDuringCached).toEqual([]);
    expect(configEvents(events)).toEqual([
      { state: "connecting", source: undefined, values: [] },
      { state: "connecting", source: "cached", values: ["cached-model"] },
      { state: "connecting", source: "live", values: ["live-model"] },
      { state: "ready", source: "live", values: ["live-model"] },
    ]);
    expect(runtime.engineConfigOptions.map((item) => item.currentValue)).toEqual(["live-model"]);
  });

  test("已有确认清单（恢复会话）时忽略缓存；失败时清空缓存副本", async () => {
    const restored = setup([]);
    restored.runtime.engineConfigOptions = [option("live-model")];
    withPort(restored.runtime, async (input) => {
      await input.onCachedConfigOptions?.([option("cached-model")]);
    });
    await prepareExternalEngineSession(restored.runtime, createRootTraceContext());
    expect(configEvents(restored.events).some((item) => item.source === "cached")).toBe(false);

    const failed = setup([]);
    withPort(failed.runtime, async (input) => {
      await input.onCachedConfigOptions?.([option("cached-model")]);
      throw new Error("handshake failed");
    });
    await expect(
      prepareExternalEngineSession(failed.runtime, createRootTraceContext()),
    ).rejects.toThrow();
    expect(configEvents(failed.events).at(-1)).toEqual({
      state: "error",
      source: undefined,
      values: [],
    });
  });
});
