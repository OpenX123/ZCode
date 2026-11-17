import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFocusedComposerScope, type ComposerPaneScope } from "#e2e/helpers/composer-pane-scope";
import { connectSSHWorkspaceAndSendFirstTurn } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";

const state = vi.hoisted(() => {
  const sent: Array<{ identity: string; model: string }> = [];
  const remoteIdentity = "remote:server:fixture:/work";
  const composerScope: ComposerPaneScope = {
    paneId: "ssh-draft-pane",
    selector: '[data-testid="v4-pane-shell-ssh-draft-pane"]',
    workspacePath: "/work",
    workspaceIdentity: remoteIdentity,
  };
  return {
    identity: "",
    model: "local-default",
    localDraftCreations: 0,
    remoteIdentity,
    composerScope,
    sent,
  };
});

vi.mock("#e2e/helpers/project-sidebar", () => ({}));
vi.mock("#e2e/helpers/desktop-app", () => ({ waitForWorkspaceApp: vi.fn() }));
vi.mock("#e2e/helpers/custom-openai-provider", () => ({}));
// scope 发现会读取真实 browser；这里只隔离 DOM 边界，仍执行真实 SSH 编排并核 pane 透传。
vi.mock("#e2e/helpers/composer-pane-scope", () => ({
  getFocusedComposerScope: vi.fn(async () => state.composerScope),
}));
vi.mock("#e2e/helpers/upstream-provider", () => ({
  selectUpstreamProviderModelById: vi.fn(async (model: string) => {
    state.model = model;
  }),
  selectUpstreamThoughtLevelValue: vi.fn(),
}));
vi.mock("#e2e/helpers/conversation-session-network", () => ({
  getUpstreamRequestRecordCount: async () => state.sent.length,
  waitForUpstreamRequest: vi.fn(),
}));
vi.mock("#e2e/helpers/v4-conversation", () => ({
  // 全局新建按产品合同切换到本地未分类任务，不能冒充远程项目内新建。
  startNewV4Draft: async () => {
    state.localDraftCreations += 1;
    state.identity = "";
    state.model = "local-default";
  },
  sendV4PromptAndWaitAccepted: async () => {
    state.sent.push({ identity: state.identity, model: state.model });
  },
  waitForV4ConversationState: async (predicate: (value: unknown) => boolean) => {
    const snapshot = {
      taskId: state.identity ? "remote-task" : "local-task",
      state: "idle",
      queueCount: 0,
    };
    expect(predicate(snapshot)).toBe(true);
    return snapshot;
  },
  waitForV4AssistantMessageContaining: vi.fn(),
}));
vi.mock("#e2e/helpers/ssh-remote-p0", () => ({
  SSH_WORKSPACE_READY_TIMEOUT_MS: 1_000,
  clickLastEnabledSSHDialogButton: vi.fn(),
  fillSSHPasswordSettings: vi.fn(),
  openSSHRemoteDialog: vi.fn(),
  ensureSSHProjectDirectoryStep: vi.fn(),
  selectSSHRemoteDirectory: async () => {
    state.identity = state.remoteIdentity;
  },
  waitForRemoteTab: async () => ({
    remoteKind: "ssh",
    remoteHost: "127.0.0.1",
    remoteSessionId: "attachment",
    secretPersistedInTab: false,
    workspaceIdentity: state.remoteIdentity,
  }),
  readRemoteTabSnapshot: async () => ({
    activeWorkspaceIdentity: state.identity || null,
    activeWorkspacePath: state.identity ? "/work" : "/local",
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("expect", expect);
  state.identity = "";
  state.model = "local-default";
  state.localDraftCreations = 0;
  state.sent.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

it("远程项目首发保留新建项目草稿和已选模型，不跳到全局本地任务", async () => {
  const task = await connectSSHWorkspaceAndSendFirstTurn({
    caseMarker: "E2E_REMOTE_DRAFT",
    config: { host: "127.0.0.1", port: 43210, username: "dev", password: "fixture" },
    label: "A",
    workspacePath: "/work",
    provider: {
      id: "fixture-provider",
      name: "Fixture provider",
      tunnel: { baseURL: "http://127.0.0.1:43211", close: async () => {} },
    },
  });
  expect(getFocusedComposerScope).toHaveBeenCalledTimes(1);
  expect(getFocusedComposerScope).toHaveBeenCalledWith({
    workspacePath: "/work",
    workspaceIdentity: state.remoteIdentity,
  });
  expect(selectUpstreamProviderModelById).toHaveBeenCalledTimes(1);
  expect(selectUpstreamProviderModelById).toHaveBeenCalledWith("e2e-ssh-remote-lifecycle-model", {
    includePlainModelFallback: false,
    providerId: "fixture-provider",
    providerName: "Fixture provider",
    composerScope: state.composerScope,
  });
  expect(vi.mocked(selectUpstreamProviderModelById).mock.calls[0]?.[1]?.composerScope).toBe(
    state.composerScope,
  );
  expect(selectUpstreamThoughtLevelValue).toHaveBeenCalledTimes(1);
  expect(selectUpstreamThoughtLevelValue).toHaveBeenCalledWith("disabled", state.composerScope);
  expect(vi.mocked(selectUpstreamThoughtLevelValue).mock.calls[0]?.[1]).toBe(state.composerScope);
  expect(state.sent).toEqual([
    { identity: state.remoteIdentity, model: "e2e-ssh-remote-lifecycle-model" },
  ]);
  expect(task.taskId).toBe("remote-task");
  expect(task.identity).toBe(state.remoteIdentity);
  expect(state.localDraftCreations).toBe(0);
});
