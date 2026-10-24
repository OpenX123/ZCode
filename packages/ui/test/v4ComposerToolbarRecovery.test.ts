import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { V4ComposerModelControls } from "@/v4/composer/V4ComposerToolbar.js";
import type { ModelConfigSelect } from "@/ModelConfigSelect.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type ModelConfigSelectProps = ComponentProps<typeof ModelConfigSelect>;
type V4ComposerModelControlsProps = ComponentProps<typeof V4ComposerModelControls>;

const customValue = "custom:custom-openai:gpt-4o";

const captured = vi.hoisted(() => ({
  modelSelectProps: null as ModelConfigSelectProps | null,
  thoughtControlProps: null as {
    indicatorClassName?: string;
    triggerClassName?: string;
    composerCollapsePriority?: number;
    onValueChange: (value: string) => void;
    option: { currentValue?: unknown; options?: Array<{ value: string }> };
  } | null,
  usageProps: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  configOptions: [] as Array<Record<string, unknown>>,
  configOptionsError: true,
  modelSelectionView: {
    revision: 1,
    providers: [
      {
        providerId: "custom-openai",
        providerName: "Custom OpenAI",
        config: {
          access: { type: "api-key", apiKey: "test-key" },
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://api.example.com/v1",
          },
          models: ["gpt-4o"],
        },
        models: [
          {
            modelId: "gpt-4o",
            config: {
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 32_000, map: "{}" },
              },
            },
          },
        ],
      },
    ],
  } as null | {
    revision: number;
    providers: Array<{
      providerId: string;
      providerName?: string;
      config: Record<string, unknown>;
      models: Array<{ modelId: string; config: Record<string, unknown> }>;
    }>;
  },
  recoverCustomModelSelection: vi.fn(async () => {}),
  selectModel: vi.fn(),
}));

function completeDisabledModelConfig() {
  return {
    optionSpecs: {
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 32_000, map: "{}" },
    },
  };
}

vi.mock("@/ModelConfigSelect.js", async () => {
  const React = await import("react");
  return {
    ModelConfigSelect: (props: ModelConfigSelectProps) => {
      captured.modelSelectProps = props;
      if (props.triggerRef && "current" in props.triggerRef) {
        (props.triggerRef as { current: HTMLSpanElement | null }).current = {
          contains: () => false,
          getClientRects: () => [{ width: 1 }] as unknown as DOMRectList,
        } as HTMLSpanElement;
      }
      return React.createElement("button", {
        "data-testid": "mock-model-select",
        disabled: props.disabled,
      });
    },
  };
});

vi.mock("@/chat-input-toolbar/display.js", async () => {
  const React = await import("react");
  return {
    ChatContextUsage: (props: Record<string, unknown>) => {
      captured.usageProps.push(props);
      return React.createElement("span", { "data-testid": "mock-usage" });
    },
  };
});

vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", async () => {
  const React = await import("react");
  return {
    ThoughtLevelCycleControl: (props: {
      onValueChange: (value: string) => void;
      option: { currentValue?: unknown; options?: Array<{ value: string }> };
    }) => {
      captured.thoughtControlProps = props;
      return React.createElement("span", { "data-testid": "mock-thought" });
    },
  };
});

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  useToolbarShortcutBindings: vi.fn(),
}));

vi.mock("@/chat-input-toolbar/modelSelection.js", () => ({
  resolveModelSelectTriggerDisplay: (value: string) => ({ value }),
  shouldShowManageModelsAction: () => false,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => vi.fn(),
}));

vi.mock("@/hooks/useSettingService.js", () => ({ useSettings: () => ({ settings: {} }) }));

vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => ({
    configOptions: mocks.configOptions,
    loading: false,
    error: mocks.configOptionsError,
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: vi.fn(),
  setPendingSettingsUsageIntent: vi.fn(),
}));

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function renderToolbarMarkup(overrides: Partial<V4ComposerModelControlsProps> = {}): string {
  // 纯工具条测试显式提供已初始化的 Composer；生产初始化由 scope owner 负责。
  const seed = overrides.config ?? {
    provider: "custom-openai",
    model: "gpt-4o",
    thought: "disabled",
    mode: "build",
  };
  return renderToStaticMarkup(
    // 工具条的通用提示组件需要 TooltipProvider。
    createElement(
      TooltipProvider,
      null,
      createElement(V4ComposerModelControls, {
        workspacePath: "/workspace",
        modelSelectionView: mocks.modelSelectionView,
        sessionId: null,
        phase: null,
        config: {
          provider: "custom-openai",
          model: "gpt-4o",
          thought: "medium",
          thoughtLevels: ["medium", "high"],
          followupMode: "queue",
          mode: "build",
        },
        usage: {
          contextWindow: {
            usedTokens: 1024,
            maxTokens: 2048,
            autoCompactThresholdTokens: null,
          },
          cumulative: {
            inputTokens: 1024,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        disabled: false,
        onSelectModel: mocks.selectModel,
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
        draftConfig: {
          mode: seed.mode,
          modelSelection: {
            providerId: seed.provider,
            modelId: seed.model,
            ...(seed.thought ? { options: { reasoningLevel: seed.thought } } : {}),
          },
        },
        ...overrides,
      }),
    ),
  );
}

function latestUsageProps(): Record<string, unknown> {
  return captured.usageProps[captured.usageProps.length - 1] ?? {};
}

afterEach(() => {
  captured.modelSelectProps = null;
  captured.thoughtControlProps = null;
  captured.usageProps = [];
  mocks.configOptions = [];
  mocks.configOptionsError = true;
  mocks.modelSelectionView = {
    revision: 1,
    providers: [
      {
        providerId: "custom-openai",
        providerName: "Custom OpenAI",
        config: {
          access: { type: "api-key", apiKey: "test-key" },
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://api.example.com/v1",
          },
          models: ["gpt-4o"],
        },
        models: [{ modelId: "gpt-4o", config: completeDisabledModelConfig() }],
      },
    ],
  };
  vi.clearAllMocks();
});

describe("V4ComposerModelControls recovery", () => {
  it("同 Host 重读保留目录时入口不切成禁用态，首次加载仍禁用", () => {
    renderToolbarMarkup({
      modelSelectionState: { status: "loading", catalog: mocks.modelSelectionView },
    });
    expect(captured.modelSelectProps?.disabled).toBe(false);
    renderToolbarMarkup({ modelSelectionState: { status: "loading" } });
    expect(captured.modelSelectProps?.disabled).toBe(true);
  });
  it("已有会话的 Composer 模型留空时仍能打开模型菜单重选", () => {
    renderToolbarMarkup({
      sessionId: "existing-session",
      draftMode: false,
      draftConfig: { mode: "build" },
    });
    expect(captured.modelSelectProps).not.toBeNull();
    expect(captured.modelSelectProps?.normalizedValue).toBe("");
    expect(captured.thoughtControlProps).toBeNull();
  });

  it("renders an explicit retry action when the target Host model view fails", () => {
    const html = renderToolbarMarkup({
      modelSelectionView: null,
      modelSelectionState: { status: "error", error: new Error("read failed") },
      modelSelectionReload: vi.fn(),
    });

    expect(html).toContain("chat.toolbar.model.loadFailedRetry");
    expect(html).not.toContain('data-testid="mock-model-select"');
  });

  it("合并入口只显示模型名，供应商保留在提示与菜单", () => {
    renderToolbarMarkup();

    expect(captured.modelSelectProps?.triggerLabel).toBe("gpt-4o");
    expect(captured.modelSelectProps?.tooltipTitle).toBe("Custom OpenAI/gpt-4o");
    expect(captured.modelSelectProps?.triggerLabelPrefix).toBeUndefined();
  });

  it("Registry 已发布时只使用 Registry providerName", () => {
    mocks.modelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "custom-openai",
          providerName: "Registry OpenAI",
          config: {
            access: { type: "api-key", apiKey: "test-key" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://registry.example.com/v1",
            },
            models: ["gpt-4o"],
          },
          models: [{ modelId: "gpt-4o", config: completeDisabledModelConfig() }],
        },
      ],
    };

    renderToolbarMarkup();

    expect(captured.modelSelectProps?.triggerLabel).toBe("gpt-4o");
    expect(captured.modelSelectProps?.tooltipTitle).toBe("Registry OpenAI/gpt-4o");
  });

  it("prewarm 未就绪时不把旧 configOptions 模型当作 Selection 来源", async () => {
    mocks.configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: customValue,
        options: [{ value: customValue, name: "GPT-4o" }],
      },
    ];
    mocks.modelSelectionView = {
      revision: 2,
      providers: [
        ...mocks.modelSelectionView!.providers,
        {
          providerId: "alternate-provider",
          providerName: "Alternate API",
          config: {
            access: { type: "api-key", apiKey: "alternate-key" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://alt.example.com/v1",
            },
            models: ["deepseek-v4-pro"],
          },
          models: [{ modelId: "deepseek-v4-pro", config: completeDisabledModelConfig() }],
        },
      ],
    };

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          config: null,
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
        }),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      captured.modelSelectProps?.onValueChange("custom:alternate-provider:deepseek-v4-pro");
      await flushMicrotasks();
    });

    expect(mocks.selectModel).toHaveBeenCalledWith("alternate-provider", "deepseek-v4-pro", null);

    await act(async () => {
      root.unmount();
    });
  });

  it("忽略模型切换期间受控 Select 产生的空 thought 事件", () => {
    mocks.configOptions = [
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ],
      },
    ];
    mocks.configOptionsError = false;
    const onSelectThought = vi.fn();

    renderToolbarMarkup({ onSelectThought });
    expect(captured.thoughtControlProps).toBeNull();
    expect(captured.modelSelectProps?.composerOptions).toBeDefined();
    captured.modelSelectProps?.composerOptions?.onValueChange("");
    expect(onSelectThought).not.toHaveBeenCalled();

    captured.modelSelectProps?.composerOptions?.onValueChange("high");
    expect(onSelectThought).toHaveBeenCalledWith("high", {
      provider: "custom-openai",
      model: "gpt-4o",
    });
  });

  it("会话态候选档位只取目标 Host View，不取旧 Session 或 workspace 目录", () => {
    mocks.configOptions = [
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "off",
        options: ["off", "low", "medium", "high", "max"].map((value) => ({ value })),
      },
    ];

    mocks.modelSelectionView!.providers[0]!.models.push({
      modelId: "GLM-5.2",
      config: {
        optionSpecs: {
          reasoningLevel: { values: ["low", "high", "max"], map: "{}" },
        },
      },
    });
    renderToolbarMarkup({
      config: {
        provider: "custom-openai",
        model: "GLM-5.2",
        thought: "high",
        thoughtLevels: ["max", "high", "nothink"],
        followupMode: "queue",
        mode: "build",
      },
    });

    expect(captured.modelSelectProps?.composerOptions?.levels.map(({ value }) => value)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it.each([{ thoughtLevels: [] }, { thoughtLevels: ["disabled"] }])(
    "恢复的空档位不被目录补齐：$thoughtLevels",
    ({ thoughtLevels }) => {
      renderToolbarMarkup({
        config: {
          provider: "custom-openai",
          model: "gpt-4o",
          thought: "",
          thoughtLevels,
          followupMode: "queue",
          mode: "build",
        },
      });
      expect(captured.modelSelectProps?.composerOptions?.value).toBe("");
    },
  );

  it("草稿预热完成后仍展示 Composer 选择与 Host 候选，不消费旧投影档位", () => {
    renderToolbarMarkup({
      draftMode: true,
      draftConfig: {
        mode: "build",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-4o",
          options: { reasoningLevel: "disabled" },
        },
      },
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "high",
        thoughtLevels: ["max", "high", "nothink"],
        followupMode: "queue",
        mode: "build",
      },
    });

    expect(captured.modelSelectProps?.composerOptions).toMatchObject({
      value: "disabled",
      levels: [{ value: "disabled" }],
    });
  });

  it("草稿切换目标模型时不复用旧预热投影的 thought 档位", () => {
    renderToolbarMarkup({
      draftMode: true,
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "high",
        thoughtLevels: ["medium", "high"],
        followupMode: "queue",
        mode: "build",
      },
      draftConfig: {
        modelSelection: { providerId: "custom-openai", modelId: "gpt-4.1" },
      },
    });

    expect(captured.thoughtControlProps).toBeNull();
  });

  it("does not pass derived capacity or plan props for a non-plan model with no usage", () => {
    renderToolbarMarkup({
      usage: null,
    });

    const props = latestUsageProps();
    expect(props).not.toHaveProperty("contextCapacityTokens");
    expect(props.codingPlanUsageRemaining).toBeUndefined();
    expect(props.startPlanBalance).toBeUndefined();
  });

  it("Registry 尚未发布时不从旧 Provider Snapshot 构造模型菜单", () => {
    mocks.modelSelectionView = null;
    renderToolbarMarkup();

    expect(captured.modelSelectProps).toBeNull();
  });

  it("routes custom model selection to the recovery callback when configOptions failed", async () => {
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          draftConfig: {
            mode: "build",
            modelSelection: {
              providerId: "primary-provider",
              modelId: "source-model",
              options: { reasoningLevel: "high" },
            },
          },
          config: {
            provider: "primary-provider",
            model: "source-model",
            thought: "high",
            thoughtLevels: ["high"],
            followupMode: "queue",
            mode: "build",
          },
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          onRecoverCustomModelSelection: mocks.recoverCustomModelSelection,
        }),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      captured.modelSelectProps?.onValueChange(customValue);
      await flushMicrotasks();
    });

    expect(mocks.recoverCustomModelSelection).toHaveBeenCalledWith(customValue, {
      provider: "primary-provider",
      model: "source-model",
    });
    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not expose a legacy-only provider after an empty Registry view is published", async () => {
    mocks.modelSelectionView = { revision: 1, providers: [] };
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          config: {
            provider: "primary-provider",
            model: "source-model",
            thought: "high",
            thoughtLevels: ["high"],
            followupMode: "queue",
            mode: "build",
          },
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          onRecoverCustomModelSelection: mocks.recoverCustomModelSelection,
        }),
      );
      await flushMicrotasks();
    });

    expect(captured.modelSelectProps).toBeNull();
    expect(mocks.recoverCustomModelSelection).not.toHaveBeenCalled();
    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not write a menu-first fallback when a session model is absent from the visible catalog", async () => {
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: "session-removed-model",
          phase: "completedSuccess",
          config: {
            provider: "removed-provider",
            model: "removed-model",
            thought: "high",
            thoughtLevels: ["high"],
            followupMode: "queue",
            mode: "build",
          },
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
        }),
      );
      await flushMicrotasks();
    });

    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});
