import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";

// docs/desktop/engine-performance-1.1-spec.md「隐藏面板暂停渲染」HP01/HP02。
// 与 v4SessionPaneSendPath 同一套最小 DOM 接线，但保留真实 useConversationProjection：
// 计数的就是 projection store 通知驱动的 SessionPane 渲染（时间线桩每次 SessionPane 渲染都会重渲）。

const mocks = vi.hoisted(() => ({
  timelineRenders: [] as Array<{ rows: readonly unknown[]; paused: unknown }>,
  releases: [] as Array<ReturnType<typeof vi.fn>>,
  layer: { acquire: vi.fn() },
  setPaneVisibleSession: vi.fn(),
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
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
    layer: mocks.layer,
    sendCommand: vi.fn(),
    workflowRuns: vi.fn(() => new Promise(() => {})),
    setPaneVisibleSession: mocks.setPaneVisibleSession,
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
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
vi.mock("@/v4/composer/useDraftSessionPrewarm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/composer/useDraftSessionPrewarm.js")>()),
  useDraftSessionPrewarm: () => ({ binding: null, error: null, waitForSession: vi.fn() }),
}));
vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return { ConversationComposer: () => React.createElement("div") };
});
vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return { ConversationHeader: () => React.createElement("div") };
});
vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: (props: {
      rows: readonly unknown[];
      paused?: unknown;
      bottomDock?: unknown;
    }) => {
      mocks.timelineRenders.push({ rows: props.rows, paused: props.paused });
      return React.createElement(React.Fragment, null, props.bottomDock as never);
    },
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

function frameRows(frame: number): ConversationRow[] {
  const base = (rowId: number) => ({ rowId, turnId: "t1", createdAt: 1, createdAtSeq: rowId });
  return [
    { ...base(1), kind: "turnHeader", origin: "userInput", state: "running", startedAt: 1 },
    { ...base(2), kind: "userInput", origin: "realUser", text: "写一段说明" },
    { ...base(3), kind: "assistantText", text: `第 ${frame} 帧`, state: "streaming" },
  ] as ConversationRow[];
}

function makeSnapshot(frame: number): ConversationSnapshot {
  const window = frameRows(frame);
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: frame + 1,
    revision: frame + 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
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
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    workspaceHookAdmission: null,
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
    rows: { window, totalCount: window.length, firstRowId: 1 },
  };
}

function storeState(frame: number): ConversationStoreState {
  return {
    status: "live",
    snapshot: makeSnapshot(frame),
    subscriptionId: "sub-1",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
    sessionPlans: [],
    planDirectoryRevision: 0,
    plansLoading: false,
    turnNavigatorDirectoryRevision: 0,
  };
}

/** 最小 projection store：与真实 store 相同的 subscribe/getState 合同，emit 模拟 CLI 帧。 */
function createFakeStore() {
  let state = storeState(0);
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitFrame(frame: number) {
      state = storeState(frame);
      for (const listener of listeners) listener();
    },
    markCommandPending: vi.fn(),
    expectAcceptedInputProjection: vi.fn(),
    recoverFromStaleAuthority: vi.fn(),
    onOnlineModelTransition: vi.fn(() => () => {}),
    onLiveDeltas: vi.fn(() => () => {}),
    refreshPlans: vi.fn(async () => {}),
    settleCommand: vi.fn(),
    loadOlder: vi.fn(async () => {}),
    loadAllOlder: vi.fn(async () => ({ status: "stale", logEpoch: "epoch-1" })),
    loadIncompleteLeadingTurn: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  };
}

function renderPane(paneVisible: boolean) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(SessionPane, {
      paneId: "tab-1",
      workspacePath: "/workspace",
      sessionId: "session-1",
      paneVisible,
    } as Parameters<typeof SessionPane>[0]),
  });
}

function lastRenderedText(): string | undefined {
  const rows = mocks.timelineRenders.at(-1)?.rows as ConversationRow[] | undefined;
  const last = rows?.at(-1);
  return last?.kind === "assistantText" ? last.text : undefined;
}

afterEach(() => {
  mocks.timelineRenders.length = 0;
  mocks.releases.length = 0;
  mocks.layer.acquire.mockReset();
  mocks.setPaneVisibleSession.mockReset();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane 隐藏面板暂停渲染", () => {
  it("HP01/HP02：已激活 Tab 隐藏后收帧不渲染，再可见一次补齐；租约全程保留", async () => {
    const store = createFakeStore();
    mocks.layer.acquire.mockImplementation((sessionId: string) => {
      const release = vi.fn();
      mocks.releases.push(release);
      return { sessionId, openKind: "cold", startedAt: 0, store, release };
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(renderPane(true));
      await flushMicrotasks();
    });
    expect(mocks.layer.acquire).toHaveBeenCalledTimes(1);
    expect(lastRenderedText()).toBe("第 0 帧");

    await act(async () => {
      root.render(renderPane(false));
      await flushMicrotasks();
    });
    const rendersWhenHidden = mocks.timelineRenders.length;

    const HIDDEN_FRAMES = 10;
    for (let frame = 1; frame <= HIDDEN_FRAMES; frame += 1) {
      await act(async () => {
        store.emitFrame(frame);
        await flushMicrotasks();
      });
    }
    // 修复前：每帧一次 SessionPane + 时间线渲染（10 次）。
    expect(mocks.timelineRenders.length - rendersWhenHidden).toBe(0);
    expect(mocks.timelineRenders.at(-1)?.paused).toBe(true);

    await act(async () => {
      root.render(renderPane(true));
      await flushMicrotasks();
    });
    // 一次补齐：可见后的首个渲染就已是隐藏期间的最后一帧。
    const firstVisible = mocks.timelineRenders[rendersWhenHidden];
    expect((firstVisible?.rows.at(-1) as { text?: string } | undefined)?.text).toBe(
      `第 ${HIDDEN_FRAMES} 帧`,
    );
    expect(mocks.timelineRenders.at(-1)?.paused).toBe(false);

    const rendersWhenVisible = mocks.timelineRenders.length;
    await act(async () => {
      store.emitFrame(HIDDEN_FRAMES + 1);
      await flushMicrotasks();
    });
    expect(mocks.timelineRenders.length).toBeGreaterThan(rendersWhenVisible);
    expect(lastRenderedText()).toBe(`第 ${HIDDEN_FRAMES + 1} 帧`);

    expect(mocks.layer.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.releases[0]).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
  });
});

describe("SessionPane 会话可见性登记", () => {
  it("VR04：可见且持有租约时登记租约 sessionId，隐藏与卸载时登记为空；首次可见前不登记会话", async () => {
    const store = createFakeStore();
    mocks.layer.acquire.mockImplementation((sessionId: string) => {
      const release = vi.fn();
      mocks.releases.push(release);
      return { sessionId, openKind: "cold", startedAt: 0, store, release };
    });
    const root: Root = createRoot(installMinimalDom());
    const latestFor = () => {
      const calls = mocks.setPaneVisibleSession.mock.calls;
      const owner = calls[0]?.[0] as string | undefined;
      const own = calls.filter(([key]) => key === owner);
      return { owner, latest: own.at(-1)?.[1] ?? null, sessions: own.map(([, id]) => id) };
    };

    await act(async () => {
      root.render(renderPane(false));
      await flushMicrotasks();
    });
    // 隐藏挂载：没有租约，也就没有可见会话。
    expect(latestFor().sessions.every((id) => id === null)).toBe(true);

    await act(async () => {
      root.render(renderPane(true));
      await flushMicrotasks();
    });
    expect(latestFor().latest).toBe("session-1");

    await act(async () => {
      root.render(renderPane(false));
      await flushMicrotasks();
    });
    expect(latestFor().latest).toBeNull();

    await act(async () => {
      root.render(renderPane(true));
      await flushMicrotasks();
    });
    expect(latestFor().latest).toBe("session-1");

    await act(async () => root.unmount());
    expect(latestFor().latest).toBeNull();
    // 同一 pane 始终用同一个登记键，聚合方据此整体替换该 pane 的贡献。
    expect(new Set(mocks.setPaneVisibleSession.mock.calls.map(([key]) => key)).size).toBe(1);
  });
});
