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
        { value: "plan", name: "Plan" },
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
  connectionProfileId?: string | null;
  engine?: SessionEngine;
  sessionId?: string | null;
  options?: EngineConfigOption[];
  restoreEnabled?: boolean;
}

type ApplyResult = { confirmedOptions?: EngineConfigOption[] } | null;
type ApplyOption = (sessionId: string, configId: string, value: string) => Promise<ApplyResult>;

/**
 * 受控引擎替身：按所选值更新状态，并像 CLI 一样在 ACK 中带回 runtime 确认后的配置。
 * gpt-a 的深度目录没有 high，切到 gpt-b 后才出现（模型决定深度目录）。
 */
function fakeEngine(model = "gpt-a", effort = "low") {
  const state = { model, effort, mode: "default" };
  return vi.fn<ApplyOption>(async (_sessionId, configId, value) => {
    if (configId === "model") state.model = value;
    else if (configId === "mode") state.mode = value;
    else state.effort = value;
    const efforts = state.model === "gpt-a" ? ["low", "medium"] : ["low", "medium", "high"];
    return { confirmedOptions: withMode(catalog(state.model, state.effort, efforts), state.mode) };
  });
}

function withMode(options: EngineConfigOption[], mode: string): EngineConfigOption[] {
  return options.map((option) =>
    option.id === "mode" ? { ...option, currentValue: mode } : option,
  );
}

function deferredAck() {
  let resolve!: (value: ApplyResult) => void;
  const promise = new Promise<ApplyResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderMemory(initial: HookProps, applyOption = fakeEngine()) {
  const view = renderHook(
    (props: HookProps) =>
      useEngineConfigMemory({
        engine: props.engine ?? "codex",
        connectionProfileId: props.connectionProfileId,
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
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

describe("按引擎记忆模型与思考深度", () => {
  it("同引擎两连接分别恢复模型与深度，已有连接记录不混入 legacy", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
      externalEngineConnectionConfigPreferences: {
        codex: { alpha: { model: "gpt-b", reasoning_effort: "medium" }, beta: { model: "gpt-a" } },
      },
    } as AppSettings;
    const { rerender, applyOption } = renderMemory({
      connectionProfileId: "alpha",
      options: catalog("gpt-a", "low"),
      restoreEnabled: true,
    });
    await flush();
    expect(applyOption.mock.calls).toEqual([
      ["session-1", "model", "gpt-b"],
      ["session-1", "reasoning_effort", "medium"],
    ]);
    applyOption.mockClear();
    rerender({
      sessionId: "session-2",
      connectionProfileId: "beta",
      options: catalog("gpt-b", "low"),
      restoreEnabled: true,
    });
    await flush();
    expect(applyOption.mock.calls).toEqual([["session-2", "model", "gpt-a"]]);
  });

  it("缺少连接记录可读 legacy，确认只写当前连接增量", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b" } },
    } as AppSettings;
    const { result } = renderMemory({
      connectionProfileId: "new-profile",
      options: catalog("gpt-a", "low"),
      restoreEnabled: true,
    });
    await flush();
    act(() => result.current.recordExplicitChange("reasoning_effort", "low"));
    expect(preferences.update).toHaveBeenCalledExactlyOnceWith({
      externalEngineConnectionConfigPreferences: {
        codex: { "new-profile": { reasoning_effort: "low" } },
      },
    });
  });

  it("身份未就绪与跨连接迟到确认不写上一连接或新连接", async () => {
    const { result, rerender } = renderMemory({
      connectionProfileId: "alpha",
      options: catalog("gpt-a", "low"),
    });
    act(() => result.current.recordExplicitChange("model", "gpt-b"));
    rerender({ connectionProfileId: null, options: catalog("gpt-b", "low") });
    act(() => result.current.recordExplicitChange("model", "gpt-b"));
    rerender({
      sessionId: "session-2",
      connectionProfileId: "beta",
      options: catalog("gpt-b", "low"),
    });
    act(() =>
      result.current.recordExplicitChange("model", "gpt-b", {
        sessionId: "session-1",
        connectionProfileId: "alpha",
      }),
    );
    expect(preferences.update).not.toHaveBeenCalled();
  });
  it("恢复顺序为模型 → 深度 → 模式；目录缺失、已是当前值与计划模式都跳过", () => {
    const remembered = { model: "gpt-b", reasoning_effort: "high", mode: "auto" };
    expect(nextEngineConfigRestoreStep(catalog("gpt-a", "low"), remembered)).toEqual({
      configId: "model",
      value: "gpt-b",
    });
    expect(
      nextEngineConfigRestoreStep(catalog("gpt-a", "low"), remembered, new Set(["model"])),
    ).toEqual({ configId: "reasoning_effort", value: "high" });
    expect(
      nextEngineConfigRestoreStep(
        catalog("gpt-a", "low"),
        remembered,
        new Set(["model", "reasoning_effort"]),
      ),
    ).toEqual({ configId: "mode", value: "auto" });
    // 旧版本或手工写入的计划类取值即使在目录内也不恢复。
    expect(nextEngineConfigRestoreStep(catalog("gpt-a", "low"), { mode: "plan" })).toBeNull();
    // 只有 configId 恰为 mode 的权限模式参与恢复；其它 other 类配置不恢复。
    expect(nextEngineConfigRestoreStep(catalog("gpt-a", "low"), { fast: "on" })).toBeNull();
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
    expect(nextEngineConfigRestoreStep(catalog("gpt-b", "high"), remembered)).toEqual({
      configId: "mode",
      value: "auto",
    });
    expect(
      nextEngineConfigRestoreStep(withMode(catalog("gpt-b", "high"), "auto"), remembered),
    ).toBeNull();
    expect(nextEngineConfigRestoreStep(catalog("gpt-a", "low"), undefined)).toBeNull();
  });

  it("显式修改在 snapshot 确认为所选值后才写入，拒绝、改值与计划模式不记忆", async () => {
    const { rerender, result } = renderMemory({ options: catalog("gpt-a", "low") });
    act(() => result.current.recordExplicitChange("model", "gpt-b"));
    expect(preferences.update).not.toHaveBeenCalled();
    rerender({ options: catalog("gpt-b", "low") });
    expect(preferences.update).toHaveBeenCalledExactlyOnceWith({
      externalEngineConnectionConfigPreferences: { codex: { inherit: { model: "gpt-b" } } },
    });
    // 引擎改用其它档位：snapshot 不出现所选值，不写入。
    act(() => result.current.recordExplicitChange("reasoning_effort", "high"));
    rerender({ options: catalog("gpt-b", "medium") });
    // 计划类模式即使确认也不记忆，新草稿不沿用 Plan。
    act(() => result.current.recordExplicitChange("mode", "plan"));
    rerender({ options: withMode(catalog("gpt-b", "medium"), "plan") });
    expect(preferences.update).toHaveBeenCalledTimes(1);
    // 权限模式确认后按引擎 + 连接写入。
    act(() => result.current.recordExplicitChange("mode", "auto"));
    rerender({ options: withMode(catalog("gpt-b", "medium"), "auto") });
    expect(preferences.update).toHaveBeenCalledTimes(2);
    expect(preferences.update).toHaveBeenLastCalledWith({
      externalEngineConnectionConfigPreferences: { codex: { inherit: { mode: "auto" } } },
    });
    preferences.update.mockClear();
    // snapshot 先于 ACK 确认时立即写入；已记住的值不重复写。
    act(() => result.current.recordExplicitChange("reasoning_effort", "medium"));
    expect(preferences.update).toHaveBeenLastCalledWith({
      externalEngineConnectionConfigPreferences: {
        codex: { inherit: { reasoning_effort: "medium" } },
      },
    });
    preferences.settings = {
      externalEngineConnectionConfigPreferences: { codex: { inherit: { model: "gpt-b" } } },
    } as AppSettings;
    rerender({ options: catalog("gpt-b", "medium") });
    act(() => result.current.recordExplicitChange("model", "gpt-b"));
    expect(preferences.update).toHaveBeenCalledTimes(1);
  });

  it("恢复按模型 → 深度 → 模式依次下发；恢复期间显式选择 Plan 也视为接管但不记忆", async () => {
    preferences.settings = {
      externalEngineConnectionConfigPreferences: {
        codex: { inherit: { model: "gpt-b", reasoning_effort: "high", mode: "auto" } },
      },
    } as AppSettings;
    const { applyOption } = renderMemory({
      sessionId: "draft-mode",
      restoreEnabled: true,
      options: catalog("gpt-a", "low", ["low", "medium"]),
    });
    await flush();
    expect(applyOption.mock.calls).toEqual([
      ["draft-mode", "model", "gpt-b"],
      ["draft-mode", "reasoning_effort", "high"],
      ["draft-mode", "mode", "auto"],
    ]);
    expect(preferences.update).not.toHaveBeenCalled();

    const pendingAck = deferredAck();
    const takeover = renderMemory(
      { sessionId: "draft-plan", restoreEnabled: true, options: catalog("gpt-a", "low") },
      vi.fn<ApplyOption>(() => pendingAck.promise),
    );
    await flush();
    const wait = takeover.result.current.waitForRestore("draft-plan");
    act(() => takeover.result.current.recordExplicitChange("mode", "plan"));
    await expect(wait).resolves.toBeUndefined();
    await act(async () => pendingAck.resolve({ confirmedOptions: catalog("gpt-b", "low") }));
    await flush();
    takeover.rerender({
      sessionId: "draft-plan",
      restoreEnabled: true,
      options: withMode(catalog("gpt-b", "low"), "plan"),
    });
    expect(takeover.applyOption).toHaveBeenCalledTimes(1);
    expect(preferences.update).not.toHaveBeenCalled();
  });

  it("没有记住深度时按项默认 high（与模型/模式记忆无关），只下发不写记忆；记住的深度优先、目录无 high 时不套用", async () => {
    preferences.settings = {} as AppSettings;
    const first = renderMemory({
      sessionId: "draft-first",
      connectionProfileId: "alpha",
      restoreEnabled: true,
      options: catalog("gpt-b", "low"),
    });
    await flush();
    expect(first.applyOption.mock.calls).toEqual([["draft-first", "reasoning_effort", "high"]]);
    await expect(first.result.current.waitForRestore("draft-first")).resolves.toBeUndefined();
    expect(preferences.update).not.toHaveBeenCalled();
    first.unmount();

    // 目录没有 high：保持引擎默认，不改成其它档位。
    const noHigh = renderMemory({
      sessionId: "draft-no-high",
      restoreEnabled: true,
      options: catalog("gpt-a", "low", ["low", "medium"]),
    });
    await flush();
    expect(noHigh.applyOption).not.toHaveBeenCalled();
    noHigh.unmount();

    // P11：只记住了模型（没有记住深度）时仍按项套用 high；先恢复模型，再按 ACK 确认的新目录
    // （gpt-b 才有 high）下发 high，且不写入记忆。
    preferences.settings = {
      externalEngineConnectionConfigPreferences: { codex: { alpha: { model: "gpt-b" } } },
    } as AppSettings;
    const modelOnly = renderMemory({
      sessionId: "draft-model-only",
      connectionProfileId: "alpha",
      restoreEnabled: true,
      options: catalog("gpt-a", "low", ["low", "medium"]),
    });
    await flush();
    expect(modelOnly.applyOption.mock.calls).toEqual([
      ["draft-model-only", "model", "gpt-b"],
      ["draft-model-only", "reasoning_effort", "high"],
    ]);
    await expect(
      modelOnly.result.current.waitForRestore("draft-model-only"),
    ).resolves.toBeUndefined();
    expect(preferences.update).not.toHaveBeenCalled();
    modelOnly.unmount();

    // 只记住了权限模式：同样补 high，模式仍按记忆最后恢复。
    preferences.settings = {
      externalEngineConnectionConfigPreferences: { codex: { alpha: { mode: "auto" } } },
    } as AppSettings;
    const modeOnly = renderMemory(
      {
        sessionId: "draft-mode-only",
        connectionProfileId: "alpha",
        restoreEnabled: true,
        options: catalog("gpt-b", "low"),
      },
      fakeEngine("gpt-b"),
    );
    await flush();
    expect(modeOnly.applyOption.mock.calls).toEqual([
      ["draft-mode-only", "reasoning_effort", "high"],
      ["draft-mode-only", "mode", "auto"],
    ]);
    modeOnly.unmount();

    // 用户显式记住的深度优先（即使是 low）：不套用 high。
    preferences.settings = {
      externalEngineConnectionConfigPreferences: {
        codex: { alpha: { model: "gpt-b", reasoning_effort: "low" } },
      },
    } as AppSettings;
    const explicitLow = renderMemory(
      {
        sessionId: "draft-explicit-low",
        connectionProfileId: "alpha",
        restoreEnabled: true,
        options: catalog("gpt-a", "medium", ["low", "medium"]),
      },
      fakeEngine("gpt-a", "medium"),
    );
    await flush();
    expect(explicitLow.applyOption.mock.calls).toEqual([
      ["draft-explicit-low", "model", "gpt-b"],
      ["draft-explicit-low", "reasoning_effort", "low"],
    ]);
    explicitLow.unmount();

    // 记住的深度不在当前目录：跳过该项，不改用 high。
    preferences.settings = {
      externalEngineConnectionConfigPreferences: {
        codex: { alpha: { reasoning_effort: "xhigh" } },
      },
    } as AppSettings;
    const unknownEffort = renderMemory(
      {
        sessionId: "draft-unknown-effort",
        connectionProfileId: "alpha",
        restoreEnabled: true,
        options: catalog("gpt-b", "low"),
      },
      fakeEngine("gpt-b"),
    );
    await flush();
    expect(unknownEffort.applyOption).not.toHaveBeenCalled();
  });

  it("新草稿原生配置就绪后先恢复模型，再按 ACK 确认的新目录恢复深度，且不写回记忆", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const { rerender, applyOption } = renderMemory({
      sessionId: "draft-1",
      restoreEnabled: true,
      options: catalog("gpt-a", "low", ["low", "medium"]),
    });
    await flush();
    // 模型 ACK 带回的目录里才有 high：深度按确认后的新目录恢复，不依赖之后的 snapshot 帧。
    expect(applyOption.mock.calls).toEqual([
      ["draft-1", "model", "gpt-b"],
      ["draft-1", "reasoning_effort", "high"],
    ]);
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
    applyOption.mockResolvedValueOnce(null);
    rerender({ sessionId: "draft-3", restoreEnabled: true, options: catalog("gpt-a", "low") });
    await flush();
    rerender({ sessionId: "draft-3", restoreEnabled: true, options: catalog("gpt-a", "low") });
    await flush();
    // 模型被拒后不重试；记忆没有深度项，按当前目录补首次默认 high（P11 按项判定）。
    expect(applyOption.mock.calls).toEqual([
      ["draft-3", "model", "gpt-b"],
      ["draft-3", "reasoning_effort", "high"],
    ]);
  });

  // P08：creating/connecting 发送在屏障外等待本草稿记忆恢复收口，之后才把 sendText 排入屏障。
  it("首发等待恢复：模型与深度依次 ACK 确认后才收口；未就绪前不收口", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const acks: Array<ReturnType<typeof deferredAck>> = [];
    const applyOption = vi.fn<ApplyOption>(() => {
      const ack = deferredAck();
      acks.push(ack);
      return ack.promise;
    });
    const { rerender, result } = renderMemory(
      { sessionId: "draft-w1", restoreEnabled: false, options: undefined },
      applyOption,
    );
    let settled = false;
    void result.current.waitForRestore("draft-w1").then(() => {
      settled = true;
    });
    await flush();
    // 发送链在 prepare ACK 后到达，snapshot 仍是 connecting：恢复尚未开始，不能放行 sendText。
    expect(settled).toBe(false);
    rerender({
      sessionId: "draft-w1",
      restoreEnabled: true,
      options: catalog("gpt-a", "low", ["low", "medium"]),
    });
    await flush();
    expect(applyOption).toHaveBeenCalledExactlyOnceWith("draft-w1", "model", "gpt-b");
    expect(settled).toBe(false);
    await act(async () => acks[0]!.resolve({ confirmedOptions: catalog("gpt-b", "low") }));
    await flush();
    expect(applyOption).toHaveBeenLastCalledWith("draft-w1", "reasoning_effort", "high");
    expect(settled).toBe(false);
    await act(async () => acks[1]!.resolve({ confirmedOptions: catalog("gpt-b", "high") }));
    await flush();
    expect(settled).toBe(true);
    // 已收口的会话再次等待立即返回。
    await expect(result.current.waitForRestore("draft-w1")).resolves.toBeUndefined();
  });

  // 修复回归：引擎接受配置却原样保留旧值时，runtime 只再发布一次相同配置，之后没有新帧；
  // 旧逻辑按 snapshot 等“值变化”永远等不到，首发卡在“正在发送”。现在以 ACK 确认值判定。
  it("首发等待恢复：引擎接受但保留旧值 → 恢复停止并收口，不再等 snapshot 帧", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const applyOption = vi.fn<ApplyOption>(async () => ({
      confirmedOptions: catalog("gpt-a", "low"),
    }));
    const { result } = renderMemory(
      { sessionId: "draft-kept", restoreEnabled: true, options: catalog("gpt-a", "low") },
      applyOption,
    );
    let settled = false;
    void result.current.waitForRestore("draft-kept").then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(true);
    // 模型未被确认为所选值：不再按未确认的目录恢复深度。
    expect(applyOption).toHaveBeenCalledExactlyOnceWith("draft-kept", "model", "gpt-b");
  });

  it("首发等待恢复：noop 或旧 CLI 无确认结果视为已是当前值，按最新 snapshot 目录继续", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const applyOption = vi.fn<ApplyOption>(async () => ({}));
    const { result } = renderMemory(
      { sessionId: "draft-noop", restoreEnabled: true, options: catalog("gpt-a", "low") },
      applyOption,
    );
    await flush();
    await expect(result.current.waitForRestore("draft-noop")).resolves.toBeUndefined();
    expect(applyOption.mock.calls).toEqual([
      ["draft-noop", "model", "gpt-b"],
      ["draft-noop", "reasoning_effort", "high"],
    ]);
  });

  it("首发等待恢复：无记忆、用户接管与引擎改用其它值都收口；中止与卸载拒绝", async () => {
    preferences.settings = {} as AppSettings;
    const noMemory = renderMemory({
      sessionId: "draft-w2",
      restoreEnabled: true,
      options: catalog("gpt-a", "low"),
    });
    await flush();
    await expect(noMemory.result.current.waitForRestore("draft-w2")).resolves.toBeUndefined();
    noMemory.unmount();

    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const pendingAck = deferredAck();
    const takeover = renderMemory(
      { sessionId: "draft-w3", restoreEnabled: true, options: catalog("gpt-a", "low") },
      vi.fn<ApplyOption>(() => pendingAck.promise),
    );
    await flush();
    const takeoverWait = takeover.result.current.waitForRestore("draft-w3");
    act(() => takeover.result.current.recordExplicitChange("model", "gpt-a"));
    await expect(takeoverWait).resolves.toBeUndefined();
    // 接管后在途恢复项的 ACK 回来也不再继续后续项。
    await act(async () => pendingAck.resolve({ confirmedOptions: catalog("gpt-b", "low") }));
    await flush();
    expect(takeover.applyOption).toHaveBeenCalledTimes(1);
    takeover.unmount();

    // 引擎接受后改用其它模型：不再按未确认的目录恢复深度，也不能让首发无限等待。
    const coercedCatalog = catalog("gpt-a", "low").map((option) =>
      option.id === "model"
        ? {
            ...option,
            currentValue: "gpt-c",
            options: [...option.options, { value: "gpt-c", name: "gpt-c" }],
          }
        : option,
    );
    const coerced = renderMemory(
      { sessionId: "draft-w4", restoreEnabled: true, options: catalog("gpt-a", "low") },
      vi.fn<ApplyOption>(async () => ({ confirmedOptions: coercedCatalog })),
    );
    await flush();
    await expect(coerced.result.current.waitForRestore("draft-w4")).resolves.toBeUndefined();
    expect(coerced.applyOption).toHaveBeenCalledExactlyOnceWith("draft-w4", "model", "gpt-b");
    coerced.unmount();

    const aborted = renderMemory({
      sessionId: "draft-w5",
      restoreEnabled: true,
      options: undefined,
    });
    const controller = new AbortController();
    const abortedWait = aborted.result.current.waitForRestore("draft-w5", controller.signal);
    controller.abort(new Error("草稿会话已切换，请重新发送"));
    await expect(abortedWait).rejects.toThrow("草稿会话已切换");
    const unmountedWait = aborted.result.current.waitForRestore("draft-w5");
    aborted.unmount();
    await expect(unmountedWait).rejects.toThrow();
  });

  it("首发等待恢复：恢复开始后连接不再就绪即拒绝，由发送链保留输入", async () => {
    preferences.settings = {
      externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
    } as AppSettings;
    const pendingAck = deferredAck();
    const { rerender, result, applyOption } = renderMemory(
      { sessionId: "draft-w6", restoreEnabled: true, options: catalog("gpt-a", "low") },
      vi.fn<ApplyOption>(() => pendingAck.promise),
    );
    await flush();
    expect(applyOption).toHaveBeenCalledTimes(1);
    const wait = result.current.waitForRestore("draft-w6");
    rerender({ sessionId: "draft-w6", restoreEnabled: true, options: undefined });
    await expect(wait).rejects.toThrow();
  });

  it("恢复中断连且在途 ACK 失败后，同绑定重连的第二次首发仍能收口", async () => {
    preferences.settings = {
      externalEngineConnectionConfigPreferences: {
        codex: { alpha: { model: "gpt-b", reasoning_effort: "high" } },
      },
    } as AppSettings;
    const pendingAck = deferredAck();
    const { rerender, result, applyOption } = renderMemory(
      {
        sessionId: "draft-reconnect",
        connectionProfileId: "alpha",
        restoreEnabled: true,
        options: catalog("gpt-a", "low"),
      },
      vi.fn<ApplyOption>(() => pendingAck.promise),
    );
    const firstWait = result.current.waitForRestore("draft-reconnect");
    rerender({
      sessionId: "draft-reconnect",
      connectionProfileId: null,
      restoreEnabled: true,
      options: undefined,
    });
    await expect(firstWait).rejects.toThrow("引擎连接已中断");
    await act(async () => pendingAck.resolve(null));
    await flush();
    rerender({
      sessionId: "draft-reconnect",
      connectionProfileId: "alpha",
      restoreEnabled: true,
      options: catalog("gpt-a", "low"),
    });
    let secondWait = "pending";
    void result.current.waitForRestore("draft-reconnect").then(
      () => {
        secondWait = "resolved";
      },
      () => {
        secondWait = "rejected";
      },
    );
    await flush();
    expect(secondWait).toBe("resolved");
    expect(applyOption).toHaveBeenCalledExactlyOnceWith("draft-reconnect", "model", "gpt-b");
  });

  it("切换绑定后旧恢复 ACK 不推进旧 effort，也不影响新绑定恢复收口", async () => {
    preferences.settings = {
      externalEngineConnectionConfigPreferences: {
        codex: {
          alpha: { model: "gpt-b", reasoning_effort: "high" },
          beta: { model: "gpt-b", reasoning_effort: "medium" },
        },
      },
    } as AppSettings;
    const oldAck = deferredAck();
    const newEngine = fakeEngine();
    const applyOption = vi.fn<ApplyOption>((sessionId, configId, value) =>
      sessionId === "draft-old" ? oldAck.promise : newEngine(sessionId, configId, value),
    );
    const { rerender, result } = renderMemory(
      {
        sessionId: "draft-old",
        connectionProfileId: "alpha",
        restoreEnabled: true,
        options: catalog("gpt-a", "low"),
      },
      applyOption,
    );
    rerender({
      sessionId: "draft-new",
      connectionProfileId: "beta",
      restoreEnabled: true,
      options: catalog("gpt-a", "low"),
    });
    await flush();
    await expect(result.current.waitForRestore("draft-new")).resolves.toBeUndefined();
    await act(async () => oldAck.resolve({ confirmedOptions: catalog("gpt-b", "low") }));
    await flush();
    expect(applyOption.mock.calls).toEqual([
      ["draft-old", "model", "gpt-b"],
      ["draft-new", "model", "gpt-b"],
      ["draft-new", "reasoning_effort", "medium"],
    ]);
    expect(preferences.update).not.toHaveBeenCalled();
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
    // 记忆只有模型：模型确认后按新目录（gpt-b 有 high）补首次默认深度 high。
    expect(applyOption.mock.calls).toEqual([
      ["draft-4", "model", "gpt-b"],
      ["draft-4", "reasoning_effort", "high"],
    ]);
    rerender({
      engine: "zcode",
      sessionId: "draft-5",
      restoreEnabled: true,
      options: catalog("gpt-a", "low"),
    });
    await flush();
    expect(applyOption).toHaveBeenCalledTimes(2);
  });
});
