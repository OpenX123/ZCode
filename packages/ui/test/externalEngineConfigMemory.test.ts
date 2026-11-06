// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AppSettings } from "@zcode/shared";
import type { EngineConfigOption, SessionEngine } from "@zcode/shared/external-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextEngineConfigRestoreStep,
  useEngineConfigMemory,
} from "../src/hooks/external-engine/index.js";

const preferences = vi.hoisted(() => ({
  settings: {} as AppSettings | null,
  loading: false,
  update: vi.fn(async (_patch: Partial<AppSettings>) => {}),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useBaseWorkspaceServices: () => ({}) }));
vi.mock("@/hooks/useSettingService.js", () => ({ useSettings: () => preferences }));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  preferences.settings = {} as AppSettings;
  preferences.loading = false;
});

function catalog(
  model: string,
  effort: string,
  efforts: readonly string[] = ["low", "medium", "high"],
): EngineConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      currentValue: "default",
      options: [
        { value: "default", name: "Manual" },
        { value: "auto", name: "Auto" },
      ],
    },
    {
      id: "model",
      name: "Model",
      currentValue: model,
      options: ["gpt-a", "gpt-b"].map((value) => ({ value, name: value })),
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      currentValue: effort,
      options: efforts.map((value) => ({ value, name: value })),
    },
  ];
}

interface HookProps {
  engine?: SessionEngine;
  sessionId?: string | null;
  options?: EngineConfigOption[];
  restoreEnabled?: boolean;
}

function renderMemory(initial: HookProps, applyOption = vi.fn(async () => true)) {
  const view = renderHook(
    (props: HookProps) =>
      useEngineConfigMemory({
        engine: props.engine ?? "codex",
        sessionId: props.sessionId === undefined ? "session-1" : props.sessionId,
        options: props.options,
        restoreEnabled: props.restoreEnabled ?? false,
        applyOption,
      }),
    { initialProps: initial },
  );
  return { ...view, applyOption };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("按引擎记忆模型与思考深度", () => {
  it("恢复顺序为模型优先；目录缺失、已是当前值与权限模式都跳过", () => {
    const remembered = { model: "gpt-b", reasoning_effort: "high", mode: "auto" };
    expect(nextEngineConfigRestoreStep(catalog("gpt-a", "low"), remembered)).toEqual({
      configId: "model",
      value: "gpt-b",
    });
    expect(
      nextEngineConfigRestoreStep(catalog("gpt-a", "low"), remembered, new Set(["model"])),
    ).toEqual({ configId: "reasoning_effort", value: "high" });
    // 记忆的模型已不在目录：只按当前目录恢复深度。
    expect(
      nextEngineConfigRestoreStep(catalog("gpt-a", "low"), { model: "retired", effort: "x" }),
    ).toBeNull();
    expect(
      nextEngineConfigRestoreStep(catalog("gpt-a", "low"), {
        model: "retired",
        reasoning_effort: "medium",
      }),
    ).toEqual({ configId: "reasoning_effort", value: "medium" });
    expect(
      nextEngineConfigRestoreStep(catalog("gpt-b", "low", ["low", "medium"]), {
        model: "gpt-b",
        reasoning_effort: "xhigh",
      }),
    ).toBeNull();
    expect(nextEngineConfigRestoreStep(catalog("gpt-b", "high"), remembered)).toBeNull();
    expect(nextEngineConfigRestoreStep(catalog("gpt-a", "low"), undefined)).toBeNull();
  });

  it("显式修改在 snapshot 确认为所选值后才写入，拒绝、改值与权限模式不记忆", async () => {
    const { rerender, result } = renderMemory({ options: catalog("gpt-a", "low") });
    act(() => result.current.recordExplicitChange("model", "gpt-b"));
    expect(preferences.update).not.toHaveBeenCalled();
    rerender({ options: catalog("gpt-b", "low") });
    expect(preferences.update).toHaveBeenCalledExactlyOnceWith({
      externalEngineConfigPreferences: { codex: { model: "gpt-b" } },
    });
    // 引擎改用其它档位：snapshot 不出现所选值，不写入。
    act(() => result.current.recordExplicitChange("reasoning_effort", "high"));
    rerender({ options: catalog("gpt-b", "medium") });
    // 权限模式沿用引擎默认，即使确认也不记忆。
    act(() => result.current.recordExplicitChange("mode", "auto"));
    rerender({
      options: catalog("gpt-b", "medium").map((option) =>
        option.id === "mode" ? { ...option, currentValue: "auto" } : option,
      ),
    });
    expect(preferences.update).toHaveBeenCalledTimes(1);
    // snapshot 先于 ACK 确认时立即写入；已记住的值不重复写。
    act(() => result.current.recordExplicitChange("reasoning_effort", "medium"));
    expect(preferences.update).toHaveBeenLastCalledWith({
      externalEngineConfigPreferences: { codex: { reasoning_effort: "medium" } },
    });
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b" } },
    } as AppSettings;
    rerender({ options: catalog("gpt-b", "medium") });
    act(() => result.current.recordExplicitChange("model", "gpt-b"));
    expect(preferences.update).toHaveBeenCalledTimes(2);
  });

  it("新草稿原生配置就绪后先恢复模型，确认后再按新目录恢复深度，且不写回记忆", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const { rerender, applyOption } = renderMemory({
      sessionId: "draft-1",
      restoreEnabled: true,
      options: catalog("gpt-a", "low", ["low", "medium"]),
    });
    await flush();
    expect(applyOption).toHaveBeenCalledExactlyOnceWith("draft-1", "model", "gpt-b");
    // 模型确认后深度目录随新模型刷新，才能恢复原目录中不存在的 high。
    rerender({ sessionId: "draft-1", restoreEnabled: true, options: catalog("gpt-b", "low") });
    await flush();
    expect(applyOption).toHaveBeenLastCalledWith("draft-1", "reasoning_effort", "high");
    rerender({ sessionId: "draft-1", restoreEnabled: true, options: catalog("gpt-b", "high") });
    await flush();
    expect(applyOption).toHaveBeenCalledTimes(2);
    expect(preferences.update).not.toHaveBeenCalled();
    // 同一预热会话只恢复一次；记忆变化不重配已打开的草稿。
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-a" } },
    } as AppSettings;
    rerender({ sessionId: "draft-1", restoreEnabled: true, options: catalog("gpt-b", "high") });
    await flush();
    expect(applyOption).toHaveBeenCalledTimes(2);
  });

  it("已有草稿、已创建会话、连接未就绪与用户接管都不恢复", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b" } },
    } as AppSettings;
    const { rerender, result, applyOption } = renderMemory({
      sessionId: "draft-2",
      restoreEnabled: false,
      options: catalog("gpt-a", "low"),
    });
    await flush();
    rerender({ sessionId: "draft-2", restoreEnabled: true, options: undefined });
    await flush();
    expect(applyOption).not.toHaveBeenCalled();
    // 用户在恢复前已显式修改：保留其选择。
    act(() => result.current.recordExplicitChange("reasoning_effort", "medium"));
    rerender({ sessionId: "draft-2", restoreEnabled: true, options: catalog("gpt-a", "medium") });
    await flush();
    expect(applyOption).not.toHaveBeenCalled();
    // 被拒绝的恢复项不重试，下一个预热会话重新按记忆恢复一次。
    applyOption.mockResolvedValueOnce(false);
    rerender({ sessionId: "draft-3", restoreEnabled: true, options: catalog("gpt-a", "low") });
    await flush();
    rerender({ sessionId: "draft-3", restoreEnabled: true, options: catalog("gpt-a", "low") });
    await flush();
    expect(applyOption).toHaveBeenCalledExactlyOnceWith("draft-3", "model", "gpt-b");
  });

  it("设置首次读取完成前等待，YCode 草稿不访问记忆", async () => {
    preferences.settings = null;
    preferences.loading = true;
    const { rerender, applyOption } = renderMemory({
      sessionId: "draft-4",
      restoreEnabled: true,
      options: catalog("gpt-a", "low"),
    });
    await flush();
    expect(applyOption).not.toHaveBeenCalled();
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b" } },
    } as AppSettings;
    preferences.loading = false;
    rerender({ sessionId: "draft-4", restoreEnabled: true, options: catalog("gpt-a", "low") });
    await flush();
    expect(applyOption).toHaveBeenCalledExactlyOnceWith("draft-4", "model", "gpt-b");
    rerender({
      engine: "zcode",
      sessionId: "draft-5",
      restoreEnabled: true,
      options: catalog("gpt-a", "low"),
    });
    await flush();
    expect(applyOption).toHaveBeenCalledTimes(1);
  });
});
