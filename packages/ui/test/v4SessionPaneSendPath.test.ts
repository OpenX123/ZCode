import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// docs/desktop/engine-performance-1.1-spec.md「启动恢复」SR01/SR02 与「Renderer 发送路径 · 草稿首发」。

const mocks = vi.hoisted(() => ({
  composerProps: [] as Array<Record<string, unknown>>,
  commitCreatedTask: vi.fn(() => new Promise<void>(() => {})),
  releases: [] as Array<ReturnType<typeof vi.fn>>,
  layer: {
    acquire: vi.fn(),
  },
  sendCommand: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      revisionAtDecision: 0,
      status: "accepted",
    }),
  ),
  promote: vi.fn(),
  projection: { current: null as unknown },
}));

const servicesMock = vi.hoisted(() => ({
  zcodeSessionService: { updateProviderRegistry: vi.fn() },
  zcodeTaskService: { restartWorkspaceProcess: vi.fn() },
}));

vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    settings: { zcodeInteractionBehavior: "queue" },
    update: vi.fn(async () => {}),
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => mocks.projection.current,
}));
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
    layer: mocks.layer,
    sendCommand: mocks.sendCommand,
    workflowRuns: workflowRunsQueryMock,
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));
vi.mock("@/project-sidebar/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project-sidebar/index.js")>()),
  useOptionalProjectDirectory: () => ({
    commitCreatedTask: mocks.commitCreatedTask,
    groups: { refresh: vi.fn(async () => {}) },
  }),
}));
vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelReadiness: {
      agentStartupAllowed: true,
      error: null,
      dismissError: vi.fn(),
      ensureReadyForSend: async () => true,
      markProviderNotReady: vi.fn(),
    },
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    draftConfigSeedSignal: 0,
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    resolveInitialDraftConfig: vi.fn(),
    promoteComposerDraft: vi.fn(),
  }),
}));
vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
    error: null,
    waitForSession: async () => ({
      sessionId: "prewarm-session",
      beginPromotion: () => true,
      promote: mocks.promote,
    }),
  }),
}));
vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: Record<string, unknown>) => {
      mocks.composerProps.push(props);
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});
vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return { ConversationHeader: () => React.createElement("div") };
});
vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    // 底部 dock 承载 Composer；测试需要拿到真实传入的 onSendText。
    ConversationTimeline: (props: { bottomDock?: unknown }) =>
      React.createElement(React.Fragment, null, props.bottomDock as never),
  };
});
vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return { ConversationStatusPanel: () => React.createElement("div") };
});
vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return { ConversationQueuePanel: () => React.createElement("div") };
});
vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return { V4InteractionDialogs: () => React.createElement("div") };
});
vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return { ConversationDraftEmptyState: () => React.createElement("div") };
});

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
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function makeSnapshot(sessionId: string): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function liveProjection(sessionId: string) {
  return {
    status: "live",
    snapshot: makeSnapshot(sessionId),
    subscriptionId: "sub-1",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
}

function stubLease(sessionId: string) {
  const release = vi.fn();
  mocks.releases.push(release);
  return {
    sessionId,
    openKind: "cold",
    startedAt: 0,
    store: {
      markCommandPending: vi.fn(),
      expectAcceptedInputProjection: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      onLiveDeltas: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
    release,
  };
}

afterEach(() => {
  mocks.composerProps.length = 0;
  mocks.releases.length = 0;
  mocks.layer.acquire.mockReset();
  mocks.sendCommand.mockClear();
  mocks.commitCreatedTask.mockClear();
  mocks.promote.mockClear();
  mocks.projection.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

function renderPane(props: Record<string, unknown>) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(SessionPane, {
      paneId: "tab-1",
      workspacePath: "/workspace",
      ...props,
    } as Parameters<typeof SessionPane>[0]),
  );
}

describe("SessionPane 启动恢复", () => {
  it("SR01/SR02：隐藏 Tab 首次可见前不订阅；可见后取得一次租约，再隐藏也保留", async () => {
    mocks.layer.acquire.mockImplementation((sessionId: string) => stubLease(sessionId));
    mocks.projection.current = liveProjection("session-1");
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(renderPane({ sessionId: "session-1", paneVisible: false }));
      await flushMicrotasks();
    });
    expect(mocks.layer.acquire).not.toHaveBeenCalled();

    await act(async () => {
      root.render(renderPane({ sessionId: "session-1", paneVisible: true }));
      await flushMicrotasks();
    });
    expect(mocks.layer.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.layer.acquire).toHaveBeenCalledWith("session-1");

    await act(async () => {
      root.render(renderPane({ sessionId: "session-1", paneVisible: false }));
      await flushMicrotasks();
    });
    expect(mocks.layer.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.releases[0]).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
  });

  it("可见挂载（缺省）保持原行为，立即取得租约", async () => {
    mocks.layer.acquire.mockImplementation((sessionId: string) => stubLease(sessionId));
    mocks.projection.current = liveProjection("session-1");
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(renderPane({ sessionId: "session-1" }));
      await flushMicrotasks();
    });
    expect(mocks.layer.acquire).toHaveBeenCalledWith("session-1");

    await act(async () => root.unmount());
  });
});

describe("SessionPane 草稿首发", () => {
  it("sendText accepted 后立即导航并结束发送，不等待目录真实行", async () => {
    mocks.layer.acquire.mockImplementation((sessionId: string) => stubLease(sessionId));
    mocks.projection.current = liveProjection("prewarm-session");
    const onSessionCreated = vi.fn();
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(renderPane({ sessionId: null, onSessionCreated }));
      await flushMicrotasks();
    });
    const onSendText = mocks.composerProps.at(-1)?.onSendText as (
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    expect(typeof onSendText).toBe("function");

    let settled = false;
    await act(async () => {
      void onSendText("hello", {
        submission: { provider: "provider-a", model: "model-a", thought: "", mode: "build" },
      }).then(() => {
        settled = true;
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(mocks.sendCommand.mock.calls.some(([envelope]) => envelope.type === "sendText")).toBe(
      true,
    );
    // 目录 commitCreatedTask 永不完成：发送仍须结束，且导航已提交。
    expect(mocks.commitCreatedTask).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenCalledWith("prewarm-session");
    expect(settled).toBe(true);

    await act(async () => root.unmount());
  });

  it("ACK 前已离开原 pane 时不再导航回新会话", async () => {
    mocks.layer.acquire.mockImplementation((sessionId: string) => stubLease(sessionId));
    mocks.projection.current = liveProjection("prewarm-session");
    let resolveAck!: () => void;
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (envelope.type === "sendText")
        await new Promise<void>((resolve) => {
          resolveAck = resolve;
        });
      return { commandId: envelope.commandId, revisionAtDecision: 0, status: "accepted" };
    });
    const onSessionCreated = vi.fn();
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(renderPane({ sessionId: null, onSessionCreated }));
      await flushMicrotasks();
    });
    const onSendText = mocks.composerProps.at(-1)?.onSendText as (
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    let sending!: Promise<unknown>;
    await act(async () => {
      sending = onSendText("hello", {
        submission: { provider: "provider-a", model: "model-a", thought: "", mode: "build" },
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(resolveAck).toBeTypeOf("function");

    await act(async () => root.unmount());
    resolveAck();
    await sending.catch(() => undefined);
    expect(onSessionCreated).not.toHaveBeenCalled();
    mocks.sendCommand.mockImplementation(
      async (envelope: CommandEnvelope): Promise<CommandAck> => ({
        commandId: envelope.commandId,
        revisionAtDecision: 0,
        status: "accepted",
      }),
    );
  });
});
