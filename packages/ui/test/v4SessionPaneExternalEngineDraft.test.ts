import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineConfigOption } from "@zcode/shared/external-engine";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// docs/desktop/external-agent-engines-spec.md「草稿预热 owner」「草稿只在可见时预热」P08 / P10：
// 预热 owner 使用真实 useDraftSessionPrewarm 与 useEngineConfigMemory，只替换协议与外围组件。

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const CLOSED_PROJECTION = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const mocks = vi.hoisted(() => ({
  composerProps: [] as Array<Record<string, unknown>>,
  layer: { acquire: vi.fn() } as { acquire: ReturnType<typeof vi.fn> },
  sendCommand: vi.fn<(envelope: CommandEnvelope) => Promise<CommandAck>>(),
  engineService: undefined as
    | { isLaunchReady: () => Promise<boolean>; invalidateStatus: () => Promise<void> }
    | undefined,
  settings: {} as Record<string, unknown>,
  projections: new Map<string, unknown>(),
  projectionListeners: new Set<() => void>(),
}));

function publishProjection(sessionId: string, projection: unknown) {
  mocks.projections.set(sessionId, projection);
  for (const listener of mocks.projectionListeners) listener();
}

vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    settings: mocks.settings,
    update: vi.fn(async () => {}),
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => ({
    zcodeSessionService: { updateProviderRegistry: vi.fn() },
    zcodeTaskService: { restartWorkspaceProcess: vi.fn() },
  }),
}));
vi.mock("@/hooks/external-engine/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/external-engine/index.js")>()),
  useExternalEngineService: () => mocks.engineService,
  useEngineConnectionControl: () => ({
    choices: [],
    currentId: undefined,
    label: undefined,
    select: vi.fn(),
    draftConnectionProfileId: () => undefined,
  }),
}));
vi.mock("@/v4/useConversationProjection.js", async () => {
  const React = await import("react");
  return {
    useConversationProjection: (lease: { sessionId: string } | null) =>
      React.useSyncExternalStore(
        (listener: () => void) => {
          mocks.projectionListeners.add(listener);
          return () => mocks.projectionListeners.delete(listener);
        },
        () =>
          lease ? (mocks.projections.get(lease.sessionId) ?? CLOSED_PROJECTION) : CLOSED_PROJECTION,
      ),
  };
});
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
    layer: mocks.layer,
    sendCommand: mocks.sendCommand,
    workflowRuns: vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));
vi.mock("@/project-sidebar/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project-sidebar/index.js")>()),
  useOptionalProjectDirectory: () => ({
    commitCreatedTask: vi.fn(() => new Promise<void>(() => {})),
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
    composerDraft: { engine: "codex" },
    draftConfig: undefined,
    draftConfigRef: { current: {} },
    draftConfigSeedSignal: 0,
    engineConfigRestorable: true,
    handleDraftSelectEngine: vi.fn(async () => {}),
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    replaceComposerDraft: vi.fn(),
    resolveInitialDraftConfig: vi.fn(),
    promoteComposerDraft: vi.fn(),
    updateComposerContent: vi.fn(),
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

/** 让 microtask 与 setTimeout(0)（预热 owner 的卸载确认）都走完。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function catalog(
  model: string,
  effort: string,
  efforts: readonly string[] = ["low", "medium", "high"],
): EngineConfigOption[] {
  return [
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

function snapshotFor(
  sessionId: string,
  engineConfigState: "connecting" | "ready",
  engineConfigOptions: EngineConfigOption[] = [],
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: false, reasonCode: "draft" },
      compact: { allowed: false, reasonCode: "draft" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "generated" },
    config: {
      provider: "",
      model: "",
      thought: "",
      followupMode: "queue",
      mode: "build",
      engine: "codex",
      engineConfigState,
      engineConfigOptions,
    },
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
  } as unknown as ConversationSnapshot;
}

function liveProjection(snapshot: ConversationSnapshot) {
  return { ...CLOSED_PROJECTION, status: "live", snapshot, subscriptionId: "sub-1" };
}

function stubLease(sessionId: string) {
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
    release: vi.fn(),
  };
}

interface CommandLogEntry {
  type: string;
  sessionId: string | null;
  payload: Record<string, unknown>;
}

/**
 * 按命令类型应答；createSession / prepare / 深度配置可由测试手动放行，其余立即 accepted。
 * setEngineConfigOption 像 CLI 一样在 ACK 中带回 runtime 确认后的配置：gpt-a 的深度目录没有 high；
 * keepModel 模拟引擎接受模型却原样保留旧值。
 */
function installCommandRouter(options: {
  prewarmSessionId: string;
  createGate?: Deferred<void>;
  prepareGate?: Deferred<void>;
  effortGate?: Deferred<void>;
  keepModel?: boolean;
}) {
  const log: CommandLogEntry[] = [];
  const engine = { model: "gpt-a", effort: "low" };
  mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
    log.push({
      type: envelope.type,
      sessionId: envelope.sessionId,
      payload: envelope.payload as Record<string, unknown>,
    });
    const accepted: CommandAck = {
      commandId: envelope.commandId,
      revisionAtDecision: 0,
      status: "accepted",
    };
    if (envelope.type === "createSession") {
      await options.createGate?.promise;
      return {
        ...accepted,
        result: { type: "createSession", sessionId: options.prewarmSessionId },
      } as CommandAck;
    }
    if (envelope.type === "prepareExternalEngineSession") await options.prepareGate?.promise;
    if (envelope.type === "setEngineConfigOption") {
      const { configId, value } = envelope.payload as { configId: string; value: string };
      if (configId === "model") {
        if (!options.keepModel) engine.model = value;
      } else {
        await options.effortGate?.promise;
        engine.effort = value;
      }
      const efforts = engine.model === "gpt-a" ? ["low", "medium"] : ["low", "medium", "high"];
      return {
        ...accepted,
        result: {
          type: "setEngineConfigOption",
          engineConfigOptions: catalog(engine.model, engine.effort, efforts),
        },
      } as CommandAck;
    }
    return accepted;
  });
  return log;
}

function relevantCommands(log: readonly CommandLogEntry[]) {
  return log
    .filter((entry) =>
      [
        "createSession",
        "prepareExternalEngineSession",
        "setEngineConfigOption",
        "sendText",
      ].includes(entry.type),
    )
    .map((entry) =>
      entry.type === "setEngineConfigOption"
        ? `${entry.type}:${String(entry.payload.configId)}=${String(entry.payload.value)}`
        : entry.type,
    );
}

function renderPane(props: Record<string, unknown>): ReactElement {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(SessionPane, {
      paneId: "external-draft-pane",
      workspacePath: "/workspace-external-draft",
      sessionId: null,
      ...props,
    } as Parameters<typeof SessionPane>[0]),
  );
}

function latestComposer() {
  return mocks.composerProps.at(-1)!;
}

function latestEngineControlsProps() {
  return (latestComposer().engineControls as ReactElement<Record<string, unknown>>).props;
}

const mountedRoots: Root[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => root.unmount());
  await settle();
  mocks.composerProps.length = 0;
  mocks.sendCommand.mockReset();
  mocks.projections.clear();
  mocks.projectionListeners.clear();
  mocks.engineService = undefined;
  mocks.settings = {};
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

function setupExternalEngine() {
  // 每个用例换一个 transport identity，避免模块级预热 owner 在用例之间复用。
  mocks.layer = { acquire: vi.fn((sessionId: string) => stubLease(sessionId)) };
  mocks.engineService = {
    isLaunchReady: vi.fn(async () => true),
    invalidateStatus: vi.fn(async () => {}),
  };
  mocks.settings = {
    zcodeInteractionBehavior: "queue",
    externalEngineConfigPreferences: { codex: { model: "gpt-b", reasoning_effort: "high" } },
  };
}

describe("外部引擎草稿只在可见时预热（P10）", () => {
  it("隐藏挂载的草稿 pane 不发 createSession；首次可见后只发一次，再隐藏不回收", async () => {
    setupExternalEngine();
    const log = installCommandRouter({ prewarmSessionId: "prewarm-p10" });
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(renderPane({ paneVisible: false }));
      await settle();
    });
    expect(log.filter((entry) => entry.type === "createSession")).toHaveLength(0);

    await act(async () => {
      root.render(renderPane({ paneVisible: true }));
      await settle();
    });
    expect(log.filter((entry) => entry.type === "createSession")).toHaveLength(1);

    // 再次隐藏（切到其它 Tab）：保留已建预热，不 deleteSession，也不重复创建。
    await act(async () => {
      root.render(renderPane({ paneVisible: false }));
      await settle();
    });
    await act(async () => {
      root.render(renderPane({ paneVisible: true }));
      await settle();
    });
    expect(log.filter((entry) => entry.type === "createSession")).toHaveLength(1);
    expect(log.filter((entry) => entry.type === "deleteSession")).toHaveLength(0);
  });
});

describe("外部引擎草稿连接中即可发送（P08）", () => {
  it("creating/connecting 可发送且无连接中文案；sendText 排在 prepare 与模型→深度记忆恢复之后", async () => {
    setupExternalEngine();
    const createGate = deferred<void>();
    const prepareGate = deferred<void>();
    const effortGate = deferred<void>();
    const prewarmSessionId = "prewarm-p08";
    const log = installCommandRouter({ prewarmSessionId, createGate, prepareGate, effortGate });
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(renderPane({}));
      await settle();
    });
    // creating：createSession 在途。可发送，不显示“正在连接引擎…”，原生配置选择器禁用。
    expect(log.map((entry) => entry.type)).toEqual(["createSession"]);
    expect(latestComposer().submissionReady).toBe(true);
    expect(latestEngineControlsProps().loading).toBe(false);
    expect(latestEngineControlsProps().configPending).toBe(true);

    const onSendText = latestComposer().onSendText as (text: string) => Promise<unknown>;
    let sendResult: unknown = "pending";
    await act(async () => {
      void onSendText("hello external").then(
        (result) => {
          sendResult = result;
        },
        (error: unknown) => {
          sendResult = error;
        },
      );
      await settle();
    });
    expect(log.some((entry) => entry.type === "sendText")).toBe(false);

    // createSession ACK：binding 建立，snapshot 仍 connecting；发送链经屏障并入后台握手。
    publishProjection(
      prewarmSessionId,
      liveProjection(snapshotFor(prewarmSessionId, "connecting")),
    );
    await act(async () => {
      createGate.resolve();
      await settle();
    });
    expect(log.map((entry) => entry.type)).toEqual([
      "createSession",
      "prepareExternalEngineSession",
    ]);
    expect(latestComposer().submissionReady).toBe(true);
    expect(latestEngineControlsProps().loading).toBe(false);
    expect(latestEngineControlsProps().configPending).toBe(true);

    // 竞态：prepare ACK 先于 ready snapshot 到达；记忆恢复尚未排入屏障，sendText 不能抢先。
    await act(async () => {
      prepareGate.resolve();
      await settle();
    });
    expect(log.some((entry) => entry.type === "sendText")).toBe(false);
    expect(sendResult).toBe("pending");

    await act(async () => {
      publishProjection(
        prewarmSessionId,
        liveProjection(
          snapshotFor(prewarmSessionId, "ready", catalog("gpt-a", "low", ["low", "medium"])),
        ),
      );
      await settle();
    });
    expect(latestEngineControlsProps().configPending).toBe(false);
    // 模型 ACK 带回新目录后立即恢复深度（不等 snapshot 帧）；深度 ACK 前仍不发送。
    expect(relevantCommands(log)).toEqual([
      "createSession",
      "prepareExternalEngineSession",
      "setEngineConfigOption:model=gpt-b",
      "setEngineConfigOption:reasoning_effort=high",
    ]);
    expect(sendResult).toBe("pending");

    await act(async () => {
      effortGate.resolve();
      await settle();
    });

    expect(relevantCommands(log)).toEqual([
      "createSession",
      "prepareExternalEngineSession",
      "setEngineConfigOption:model=gpt-b",
      "setEngineConfigOption:reasoning_effort=high",
      "sendText",
    ]);
    expect(log.find((entry) => entry.type === "sendText")?.sessionId).toBe(prewarmSessionId);
    expect(sendResult).toBe("sent");
  });

  // 修复回归：引擎接受模型却原样保留旧值时 runtime 只再发布一次相同配置、之后没有新帧；
  // 旧的按帧等待会让首发永远“正在发送”。恢复以 ACK 确认值为准：停止恢复，首发照常只发一次。
  it("引擎接受但保留旧模型：恢复停止，连接中发出的首发照常只发一次", async () => {
    setupExternalEngine();
    const prewarmSessionId = "prewarm-kept";
    const log = installCommandRouter({ prewarmSessionId, keepModel: true });
    publishProjection(
      prewarmSessionId,
      liveProjection(snapshotFor(prewarmSessionId, "connecting")),
    );
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    await act(async () => {
      root.render(renderPane({}));
      await settle();
    });
    const onSendText = latestComposer().onSendText as (text: string) => Promise<unknown>;
    let sendResult: unknown = "pending";
    await act(async () => {
      void onSendText("hello kept").then(
        (result) => {
          sendResult = result;
        },
        (error: unknown) => {
          sendResult = error;
        },
      );
      await settle();
    });
    expect(sendResult).toBe("pending");

    await act(async () => {
      publishProjection(
        prewarmSessionId,
        liveProjection(snapshotFor(prewarmSessionId, "ready", catalog("gpt-a", "low"))),
      );
      await settle();
    });
    expect(relevantCommands(log)).toEqual([
      "createSession",
      "prepareExternalEngineSession",
      "setEngineConfigOption:model=gpt-b",
      "sendText",
    ]);
    expect(sendResult).toBe("sent");
  });

  it("预热被禁用（无本机引擎服务）时不可发送，也不创建预热会话", async () => {
    setupExternalEngine();
    mocks.engineService = undefined;
    const log = installCommandRouter({ prewarmSessionId: "prewarm-disabled" });
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(renderPane({}));
      await settle();
    });
    expect(latestComposer().submissionReady).toBe(false);
    expect(log.filter((entry) => entry.type === "createSession")).toHaveLength(0);
  });
});
