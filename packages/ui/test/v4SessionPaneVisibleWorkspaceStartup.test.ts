import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// docs/desktop/engine-performance-1.1-spec.md「只为可见工作区启动 CLI」VW01/VW02。
// 窗口打开时每个已挂载的 SessionPane（含隐藏 Tab）都经 useDraftConfigControl 读取 workspace 目录
// （readWorkspacePresentation，Host 侧 start-if-needed），不可见工作区因此各被拉起一个 CLI。
// 这里保留真实 useDraftConfigControl，只把目录读取（即拉起 CLI 的请求）换成计数桩。

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  releases: [] as Array<ReturnType<typeof vi.fn>>,
  layer: { acquire: vi.fn() },
}));

const servicesMock = vi.hoisted(() => ({
  zcodeSessionService: { updateProviderRegistry: vi.fn() },
  zcodeTaskService: { restartWorkspaceProcess: vi.fn() },
  modelSelectionService: {
    getView: vi.fn(
      async (): Promise<ModelSelectionView> =>
        ({
          revision: 1,
          providers: [{ providerId: "p", config: {}, models: [{ modelId: "m", config: {} }] }],
        }) as unknown as ModelSelectionView,
    ),
    onDidChange: () => ({ dispose: () => {} }),
  },
}));

vi.mock("@/hooks/useWorkspacePrepare.js", () => ({
  prepareWorkspaceWithZCodeSessionService: mocks.prepare,
}));
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({ readWorkspacePresentation: vi.fn() }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useWorkspaceServices.js")>()),
  useBaseWorkspaceServices: () => ({}),
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
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
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
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function stubLease(sessionId: string) {
  const release = vi.fn();
  mocks.releases.push(release);
  const state = {
    status: "connecting",
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
  return {
    sessionId,
    openKind: "cold",
    startedAt: 0,
    store: {
      getState: () => state,
      subscribe: () => () => {},
      markCommandPending: vi.fn(),
      expectAcceptedInputProjection: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      onLiveDeltas: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
      loadIncompleteLeadingTurn: vi.fn(async () => {}),
    },
    release,
  };
}

function renderWorkbench(visibleWorkspace: string) {
  // 三个工作区各有一个已恢复的会话 Tab；只有一个可见（与工作台布局一致：其余 Tab 隐藏但不卸载）。
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: ["/w1", "/w2", "/w3"].map((workspacePath) =>
      createElement(SessionPane, {
        key: workspacePath,
        paneId: `tab-${workspacePath}`,
        workspacePath,
        sessionId: `session-${workspacePath.slice(1)}`,
        paneVisible: workspacePath === visibleWorkspace,
      } as Parameters<typeof SessionPane>[0] & { key: string }),
    ),
  });
}

function preparedWorkspaces(): string[] {
  return mocks.prepare.mock.calls.map(
    ([params]) => (params as { workspacePath: string }).workspacePath,
  );
}

afterEach(() => {
  mocks.prepare.mockReset();
  mocks.releases.length = 0;
  mocks.layer.acquire.mockReset();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("只为可见工作区启动 CLI", () => {
  it("VW01/VW02：挂载 3 个工作区、只有 1 个可见时只读 1 个工作区目录；切到其他工作区时再读", async () => {
    mocks.prepare.mockResolvedValue({
      workspacePath: "",
      preparedSessionId: "",
      version: "ZCode Protocol/1",
      provider: "zcode",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [{ value: "build", name: "Build" }],
        },
      ],
      slashCommands: [{ name: "review", description: "review" }],
    });
    mocks.layer.acquire.mockImplementation((sessionId: string) => stubLease(sessionId));
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(renderWorkbench("/w1"));
      await flushMicrotasks();
    });
    // 修复前：三个工作区各读一次目录（各拉起一个 CLI）。
    expect(preparedWorkspaces()).toEqual(["/w1"]);
    expect(mocks.layer.acquire).toHaveBeenCalledTimes(1);

    // 用户切到 /w2：首次可见时读取（拉起该工作区 CLI）。
    await act(async () => {
      root.render(renderWorkbench("/w2"));
      await flushMicrotasks();
    });
    expect(preparedWorkspaces()).toEqual(["/w1", "/w2"]);

    // 切回 /w1：/w2 隐藏后不重复读取，/w3 从未可见仍不读取。
    await act(async () => {
      root.render(renderWorkbench("/w1"));
      await flushMicrotasks();
    });
    expect(preparedWorkspaces()).toEqual(["/w1", "/w2"]);

    await act(async () => root.unmount());
  });
});
