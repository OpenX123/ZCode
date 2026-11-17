/* eslint-disable max-lines -- SSH lifecycle case 共用 setup/teardown、身份与故障辅助逻辑，集中维护以保持同一安全边界。 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getFocusedComposerScope } from "./composer-pane-scope.js";
import {
  clickRemoteHostConnect,
  projectSectionSelector,
  waitForProjectRowGone,
  waitForTaskRowInProject,
  type SidebarProjectScope,
} from "./project-sidebar.js";
import { removeRemoteProjectEntryForRow } from "./remote-project-handoff-probe.js";
import { TID_TASK_ITEM, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared/test-ids";
import {
  waitForWorkspaceApp,
  switchToWorkspaceRendererWindow,
  waitForTestIdByDom,
} from "./desktop-app.js";
import {
  seedCustomOpenAIChatCompletionsProvider,
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomAnthropicMessagesProvider,
} from "./custom-openai-provider.js";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "./upstream-provider.js";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "./conversation-session-network.js";
import {
  prepareV4ConversationE2E,
  getV4Messages,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "./v4-conversation.js";
import { hasAssistantReplyForUserTurn } from "./conversation-turn-evidence.js";
import {
  clickLastEnabledSSHDialogButton,
  createSSHReplayTunnel,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHCreationOriginDraft,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  ensureSSHProjectDirectoryStep,
  waitForRemoteTab,
  type ReplayTunnel,
  type SSHConnectionConfig,
  type SSHRuntimeConfig,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "./ssh-remote-p0.js";

export const SSH_LIFECYCLE_MODEL_ID = "e2e-ssh-remote-lifecycle-model";
/** lifecycle 自定义模型暴露思考档位选择器，回放 fixture 按不思考录制。 */
export const SSH_LIFECYCLE_THOUGHT_LEVEL = "disabled";
export const SSH_LIFECYCLE_TURN_TIMEOUT_MS = 2 * 60_000;
let followTurnSequence = 0;

export interface SSHLifecycleTask {
  firstPrompt: string;
  firstReply: string;
  followPrompt: string;
  followReply: string;
  identity: string;
  label: "A" | "B";
  remoteSessionId: string;
  taskId: string;
  workspacePath: string;
  projectScope?: SidebarProjectScope;
}

export interface SSHLifecycleProvider {
  id: string;
  name: string;
  tunnel: ReplayTunnel;
}

export interface SSHLifecycleProviderOptions {
  apiType?: "openai-chat-completions" | "anthropic-messages";
  tunnelUsername?: string;
}

async function captureSSHModelSelectionFailure(label: "A" | "B") {
  if (process.env.ZCODE_E2E_FAILURE_ARTIFACTS !== "1") return;
  const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts");
  const snapshot = await browser.execute(() => {
    const describe = (element: Element | null) => {
      if (!element) return { exists: false };
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        exists: true,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none",
        tag: element.tagName,
        testId: element.getAttribute("data-testid"),
        role: element.getAttribute("role"),
        disabled: element instanceof HTMLButtonElement ? element.disabled : null,
        ariaDisabled: element.getAttribute("aria-disabled"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    };
    const trigger = document.querySelector('[data-testid="chat-model-select-trigger"]');
    const rect = trigger?.getBoundingClientRect();
    const centerElement = rect
      ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      : null;
    return {
      trigger: describe(trigger),
      triggers: Array.from(
        document.querySelectorAll('[data-testid="chat-model-select-trigger"]'),
      ).map((button) => ({
        ...describe(button),
        paneId: button.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null,
      })),
      centerElement: describe(centerElement),
      triggerContainsCenter:
        trigger !== null && centerElement !== null && trigger.contains(centerElement),
      panes: Array.from(document.querySelectorAll("[data-pane-id]")).map((pane) => ({
        ...describe(pane),
        paneId: pane.getAttribute("data-pane-id"),
        groupActive: pane.getAttribute("data-group-active"),
        focused: pane.getAttribute("data-focused"),
        restoredUnvalidated: pane.getAttribute("data-restored-unvalidated"),
      })),
      sshDialog: describe(document.querySelector('[data-testid="ssh-dialog"]')),
      settingsPage: describe(document.querySelector('[data-testid="settings-page"]')),
    };
  });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `ssh-model-selection-failure-${label}.json`),
    JSON.stringify(snapshot, null, 2),
  );
  await browser.saveScreenshot(resolve(artifactDir, `ssh-model-selection-failure-${label}.png`));
}

async function recordSSHProjectScope(observation: Record<string, unknown>): Promise<void> {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  await mkdir(artifactDir, { recursive: true });
  await appendFile(
    resolve(artifactDir, "ssh-project-scope.ndjson"),
    `${JSON.stringify(observation)}\n`,
  );
}

export async function createSSHLifecycleProvider(
  config: SSHConnectionConfig,
  caseMarker: string,
  options: SSHLifecycleProviderOptions = {},
): Promise<SSHLifecycleProvider> {
  const tunnel = await createSSHReplayTunnel(
    config,
    caseMarker,
    options.tunnelUsername ? { username: options.tunnelUsername } : {},
  );

  try {
    const provider =
      options.apiType === "anthropic-messages"
        ? await seedCustomAnthropicMessagesProvider({
            baseURL: `${tunnel.baseURL}/anthropic`,
            modelId: SSH_LIFECYCLE_MODEL_ID,
            providerId: `e2e-ssh-remote-lifecycle-${Date.now()}`,
            providerName: `SSH remote lifecycle ${Date.now()}`,
          })
        : await seedCustomOpenAIChatCompletionsProvider({
            baseURL: tunnel.baseURL,
            modelId: SSH_LIFECYCLE_MODEL_ID,
            providerId: `e2e-ssh-remote-lifecycle-${Date.now()}`,
            providerName: `SSH remote lifecycle ${Date.now()}`,
          });
    // 这里只准备本机模型；用例继续通过真实连接验证远端 Provisioning。
    // 显式刷新 Registry，避免依赖文件轮询延迟或重复测试设置页的新增表单。
    const beforeRefresh = await readRemoteTabSnapshot();
    await refreshSeededOpenAIProvidersThroughSettings([provider.name], {
      workspacePath: beforeRefresh.activeWorkspacePath,
    });
    return { ...provider, tunnel };
  } catch (error) {
    await tunnel.close();
    throw error;
  }
}

export async function connectSSHWorkspaceAndSendFirstTurn(options: {
  caseMarker: string;
  config: SSHConnectionConfig;
  provider: SSHLifecycleProvider;
  label: "A" | "B";
  workspacePath: string;
  captureProjectScope?: boolean;
  completionStrategy?: "origin-draft";
}): Promise<SSHLifecycleTask> {
  const origin =
    options.completionStrategy === "origin-draft"
      ? await readSSHCreationOriginDraft(options.caseMarker)
      : undefined;
  if (origin)
    await recordSSHProjectScope({
      stage: "creation-origin-draft",
      label: options.label,
      ...origin,
    });
  // 全局连接入口不依赖空草稿；避免为准备 SSH 额外创建本地目录和触发 workspace 切换。
  await openSSHRemoteDialog(options.caseMarker);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(options.caseMarker);
  await ensureSSHProjectDirectoryStep(options.config, options.caseMarker);
  const projectObservation: { scope?: SidebarProjectScope } = {};
  await selectSSHRemoteDirectory(options.workspacePath, options.caseMarker, {
    ...(origin ? { completion: { kind: "origin-draft" as const, origin } } : {}),
    ...(options.captureProjectScope
      ? {
          onProjectCreated: async (scope: SidebarProjectScope) => {
            projectObservation.scope = scope;
            await recordSSHProjectScope({
              stage: "project-created",
              label: options.label,
              workspacePath: options.workspacePath,
              ...scope,
            });
          },
        }
      : {}),
  });
  const projectScope = projectObservation.scope;
  if (options.captureProjectScope && !projectScope)
    throw new Error(`${options.caseMarker}: 缺少本次实际创建的项目身份`);
  await waitForWorkspaceApp(options.workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

  const tab = await waitForRemoteTab({
    caseMarker: options.caseMarker,
    expectedPath: options.workspacePath,
    expectedIdentity: projectScope?.workspaceIdentity,
  });
  expect(tab.remoteKind).toBe("ssh");
  expect(tab.remoteHost).toBe(options.config.host);
  expect(tab.secretPersistedInTab).toBe(false);
  if (!tab.remoteSessionId) {
    throw new Error(`${options.caseMarker}: workspace ${options.label} 缺少 remoteSessionId`);
  }
  if (!tab.workspaceIdentity) {
    throw new Error(`${options.caseMarker}: workspace ${options.label} 缺少稳定 workspaceIdentity`);
  }

  try {
    const composerScope = await getFocusedComposerScope({
      workspacePath: options.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
    });
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: options.provider.id,
      providerName: options.provider.name,
      composerScope,
    });
    // Bug 原因：切换到新模型后必须显式选择思考档位；和模型点击绑定同一活动 pane。
    await selectUpstreamThoughtLevelValue(SSH_LIFECYCLE_THOUGHT_LEVEL, composerScope);
  } catch (error) {
    // 修复依据：原等待失败后 after 清理会销毁现场；只读白名单取证不能覆盖原始失败。
    await captureSSHModelSelectionFailure(options.label).catch(() => undefined);
    throw error;
  }
  // 根因：项目创建已打开远端草稿，再点全局“新建任务”会切到本地未分类目录并重置模型，
  // 甚至让回放通过掩盖错误执行归属。复用项目草稿，并在发送前核对权威 workspace identity。
  const draft = await readRemoteTabSnapshot(tab.workspaceIdentity, options.workspacePath);
  expect(draft.activeWorkspaceIdentity).toBe(tab.workspaceIdentity);
  expect(draft.activeWorkspacePath).toBe(options.workspacePath);

  // fixture contract 使用稳定的 case/label 标记；run 身份已由 E2E profile 隔离。
  const marker = options.caseMarker.startsWith("E2E_")
    ? `${options.caseMarker}_${options.label}`
    : `E2E_${options.caseMarker}_${options.label}`;
  const replyMarker = options.caseMarker.startsWith("E2E_")
    ? options.caseMarker.slice("E2E_".length)
    : options.caseMarker;
  const task = {
    firstPrompt: `${marker}_FIRST_PROMPT`,
    firstReply: `${replyMarker}_REPLY`,
    followPrompt: `${marker}_FOLLOW_PROMPT`,
    followReply: `${replyMarker}_REPLY`,
  };
  const requestStart = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${task.firstPrompt}: 只回复 ${task.firstReply}`,
    task.firstPrompt,
    `${options.caseMarker}: workspace ${options.label} 首发没有被接受`,
  );
  // 首回合只是准备历史。快速 replay 可以在 DOM 接受屏障之前已完成；业务 running 窗口
  // 由各 case 的 controlled-stream 单独验证，不能要求探针命中一个已经过去的瞬态。
  const running = await waitForV4ConversationState(
    (snapshot) => Boolean(snapshot.taskId && snapshot.taskId !== "draft"),
    `${options.caseMarker}: workspace ${options.label} 首发没有建立会话`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  if (!running.taskId) {
    throw new Error(`${options.caseMarker}: workspace ${options.label} 首发没有 taskId`);
  }

  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [task.firstPrompt] },
    `${options.caseMarker}: workspace ${options.label} 首发没有到达 provider`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await waitForV4AssistantMessageContaining(task.firstReply, SSH_LIFECYCLE_TURN_TIMEOUT_MS);
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === running.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
    `${options.caseMarker}: workspace ${options.label} 首发没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );

  return {
    ...task,
    identity: tab.workspaceIdentity,
    label: options.label,
    remoteSessionId: tab.remoteSessionId,
    taskId: running.taskId,
    workspacePath: options.workspacePath,
    ...(projectScope ? { projectScope } : {}),
  };
}

export async function sendSSHFollowTurn(
  task: SSHLifecycleTask,
  caseMarker: string,
  foreignPrompt?: string,
): Promise<void> {
  await selectV4TaskById(task.taskId, 30_000);
  await waitForRemoteTab({
    caseMarker,
    expectedIdentity: task.identity,
    expectedPath: task.workspacePath,
    expectedRemoteSessionId: task.remoteSessionId,
  });
  const requestStart = await getUpstreamRequestRecordCount();
  // 稳定 fixture 前缀保留；同一 worker 内给每次续发独立标记，避免历史回复满足等待。
  const followMarker = `${task.followPrompt}:turn-${++followTurnSequence}:`;
  const requestQuery = {
    excludes: ["CRITICAL: Respond with TEXT ONLY", ...(foreignPrompt ? [foreignPrompt] : [])],
    includes: [task.firstPrompt],
    lastUserMessageIncludes: [followMarker],
  };
  await sendV4PromptAndWaitAccepted(
    `${followMarker} 只回复 ${task.followReply}`,
    followMarker,
    `${caseMarker}: workspace ${task.label} 续发没有被接受`,
  );
  await waitForUpstreamRequest(
    requestQuery,
    `${caseMarker}: workspace ${task.label} 续发历史或目标 workspace 错误`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await browser.waitUntil(
    async () => hasAssistantReplyForUserTurn(await getV4Messages(), followMarker, task.followReply),
    {
      timeout: SSH_LIFECYCLE_TURN_TIMEOUT_MS,
      timeoutMsg: `${caseMarker}: workspace ${task.label} 本次续发没有新 assistant 回复`,
    },
  );
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === task.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
    `${caseMarker}: workspace ${task.label} 续发没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  await browser.waitUntil(
    async () => {
      const requests = await getUpstreamRequestEvidence(requestQuery, {
        afterIndex: requestStart - 1,
      });
      return (
        requests.length === 1 &&
        requests[0]!.status === "complete" &&
        requests[0]!.statusCode === 200
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `${caseMarker}: workspace ${task.label} 续发不是一次完整成功的模型请求`,
    },
  );
}

/**
 * 从本机侧栏移除远端项目入口。对应旧「移除 SSH workspace」：
 * 虚拟项目下远端组织态留在远端，本机只移除入口与缓存，不触发远端删除。
 * 在线项目菜单不再提供该动作，这里直接调用本机入口服务。
 */
export async function removeRemoteProjectEntry(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  await removeRemoteProjectEntryForRow(projectSectionSelector(workspacePath));
  await waitForProjectRowGone(workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 远端项目 ${workspacePath} 移除后仍在侧栏`,
  });
}

export type RemoteWorkspaceFaultOutcome = "retained-disconnected" | "self-healed";

export async function waitForRemoteWorkspaceFaultSettled(
  identity: string,
  caseMarker: string,
  staleSessionId: string | null,
  probeContext?: () => Promise<unknown>,
  options: { requireAutomatic?: boolean } = {},
): Promise<RemoteWorkspaceFaultOutcome> {
  // 远端 server 挂掉后有两条都合法的路径：停在 disconnected 保留态等用户点重连，
  // 或者产品自己拉起新 server、换成新的 remoteSessionId。服务器上实测走的是后者
  // （现场 sessionsBeforeFault.A=9effdcc2…，超时时读到 9dcde31a…，远端 status.json
  // 已是新 pid + state:"ready"）。只认前者会把自愈误判成"没有进入断开态"。
  // 这条判定真正要守的是：故障之后绝不能继续沿用故障前的 session。
  let outcome: RemoteWorkspaceFaultOutcome | null = null;
  let lastProbe: unknown = "not-probed";
  await browser
    .waitUntil(
      async () => {
        try {
          const snapshot = await readRemoteTabSnapshot(identity);
          lastProbe = {
            workspaceIdentity: snapshot.workspaceIdentity,
            remoteSessionId: snapshot.remoteSessionId,
          };
          if (snapshot.workspaceIdentity !== identity) return false;
          if (snapshot.remoteSessionId === null) {
            // 严格自动恢复专项仍使用原预算；短暂离线不是成功，也不能触发手动fallback。
            if (options.requireAutomatic) return false;
            outcome = "retained-disconnected";
            return true;
          }
          if (staleSessionId !== null && snapshot.remoteSessionId !== staleSessionId) {
            outcome = "self-healed";
            return true;
          }
          return false;
        } catch (error) {
          lastProbe = { error: error instanceof Error ? error.message : String(error) };
          return false;
        }
      },
      { timeout: SSH_WORKSPACE_READY_TIMEOUT_MS },
    )
    .catch(async (error: unknown) => {
      const context = probeContext
        ? await probeContext().catch((probeError: unknown) => ({
            probeError: probeError instanceof Error ? probeError.message : String(probeError),
          }))
        : null;
      throw new Error(
        `${caseMarker}: 远端 server 故障后既没有进入 disconnected 保留态、也没有换成新 session（stale=${staleSessionId ?? "unknown"}）；现场: ${JSON.stringify(lastProbe)}；补充: ${JSON.stringify(context)}`,
        { cause: error },
      );
    });
  if (outcome === null) {
    throw new Error(`${caseMarker}: 故障处理结果未判定`);
  }
  return outcome;
}

export async function waitForRemoteWorkspaceDisconnected(
  identity: string,
  caseMarker: string,
  // 超时后再取一次的补充事实（远端此刻还有没有 server 进程、故障前的 sessionId 是多少）。
  // 只有对比 sessionId 才能区分"产品没检测到断链"和"产品已经自愈重连（换了新 session）"。
  probeContext?: () => Promise<unknown>,
): Promise<void> {
  // 现场事实：这条判定把 readRemoteTabSnapshot 的异常整个吞掉，超时后无法区分
  // 「tab 还在但 remoteSessionId 没清空」（产品没检测到断链）和「tab 直接消失了」
  // （保留态本身没实现）。记录最后一次探测结果再抛。
  let lastProbe: unknown = "not-probed";
  await browser
    .waitUntil(
      async () => {
        try {
          const snapshot = await readRemoteTabSnapshot(identity);
          lastProbe = {
            workspaceIdentity: snapshot.workspaceIdentity,
            remoteSessionId: snapshot.remoteSessionId,
          };
          return snapshot.workspaceIdentity === identity && snapshot.remoteSessionId === null;
        } catch (error) {
          lastProbe = { error: error instanceof Error ? error.message : String(error) };
          return false;
        }
      },
      { timeout: SSH_WORKSPACE_READY_TIMEOUT_MS },
    )
    .catch(async (error: unknown) => {
      const context = probeContext
        ? await probeContext().catch((probeError: unknown) => ({
            probeError: probeError instanceof Error ? probeError.message : String(probeError),
          }))
        : null;
      throw new Error(
        `${caseMarker}: remote workspace 没有进入 disconnected 保留态（expected identity=${identity}）；现场: ${JSON.stringify(lastProbe)}；补充: ${JSON.stringify(context)}`,
        { cause: error },
      );
    });
}

/** 点击远端项目所属 host 分组的连接按钮；对应旧「重连 SSH workspace」。 */
export async function reconnectRemoteProjectHost(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  await clickRemoteHostConnect(workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 远端项目 ${workspacePath} 没有显示可用的重连按钮`,
  });
}

export async function listRemoteZCodeServerPids(config: SSHConnectionConfig): Promise<number[]> {
  const result = await runSSHCommand(config, "ps -eo pid=,args=");
  if (result.code !== 0) {
    throw new Error(`读取远端 zcode-server PID 失败: ${result.stderr}`);
  }
  // 缺陷原因：这里原先匹配 `zcode-server.cjs`，而 3.12 的 release 布局早已把 daemon 换成
  // <release>/runtime/server-cli.js serve --supervisor（工作进程是 server-core.js）。旧名字
  // 在远端根本不存在，匹配结果恒为空数组，SSH-P0-LIFE-02 只会报 before=/current= 全空，
  // 看不出是探测失效而不是产品没起 server（2026-09-15 服务器全量实测）。
  // 只认 daemon 一个角色：core 由 daemon 拉起，若一并计入，「一次连接新增恰好一个」的
  // 合同就不成立了。
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+.*server-cli\.js\s+serve\b/u);
      return match ? [Number.parseInt(match[1]!, 10)] : [];
    })
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

// daemon 拉起的工作进程（server-core.js）。故障注入要连它一起停，否则 daemon 死了、
// core 还在服务已建立的会话，UI 根本不会进入断开态。
async function listRemoteServerCorePids(
  config: SSHConnectionConfig,
  parentPid?: number,
): Promise<number[]> {
  const result = await runSSHCommand(config, "ps -eo pid=,ppid=,args=");
  if (result.code !== 0) {
    throw new Error(`读取远端 zcode server core PID 失败: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+.*server-core\.js\b/u);
      if (!match) return [];
      const pid = Number.parseInt(match[1]!, 10);
      const ppid = Number.parseInt(match[2]!, 10);
      if (parentPid !== undefined && ppid !== parentPid) return [];
      return [pid];
    })
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

export async function stopOwnedSSHServer(
  config: SSHConnectionConfig,
  beforePids: readonly number[],
  caseMarker: string,
): Promise<number> {
  const currentPids = await listRemoteZCodeServerPids(config);
  const owned = currentPids.filter((pid) => !beforePids.includes(pid));
  if (owned.length !== 1) {
    throw new Error(
      `${caseMarker}: 只允许终止本 case 新建的一个 zcode-server，before=${beforePids.join(",")}, current=${currentPids.join(",")}`,
    );
  }
  const pid = owned[0]!;
  // 缺陷原因：daemon 是 server-cli.js serve --supervisor，真正服务会话的是它拉起的
  // server-core.js。只 TERM daemon 时 core 继续服务已建立的会话，UI 不会进入断开保留态
  // （实测现场 remoteSessionId 始终是有效 id）。顺序必须是先停 daemon——它的职责就是把
  // 崩掉的 core 拉回来——再停 core，最后等两者都退出。
  const corePids = await listRemoteServerCorePids(config, pid);
  const result = await runSSHCommand(config, `kill -TERM -- ${pid}`);
  if (result.code !== 0) {
    throw new Error(`${caseMarker}: 终止远端 zcode-server ${pid} 失败: ${result.stderr}`);
  }
  if (corePids.length > 0) {
    await runSSHCommand(config, `kill -TERM -- ${corePids.join(" ")}`).catch(() => undefined);
  }
  await browser.waitUntil(
    async () => {
      const [daemons, cores] = await Promise.all([
        listRemoteZCodeServerPids(config),
        listRemoteServerCorePids(config),
      ]);
      return !daemons.includes(pid) && corePids.every((corePid) => !cores.includes(corePid));
    },
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      timeoutMsg: `${caseMarker}: 远端 zcode-server ${pid}（core=${corePids.join(",") || "none"}）没有退出`,
    },
  );
  return pid;
}

export async function waitForRendererAfterColdRestart(caseMarker: string): Promise<void> {
  // 冷重启必须复用 handle/target 交集校验；裸 CDP targetId 可能仍绑定过渡页。
  // 此处只等主界面可操作，不强制切换到本机项目，以保留远程恢复的验收状态。
  await switchToWorkspaceRendererWindow("", 60_000);
  await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 60_000,
    timeoutMsg: `${caseMarker}: cold restart 后主界面尚未就绪`,
  });
}

/** task 行必须恢复到其 workspace 对应的项目 section 内且无错误标记。 */
export async function readTaskRowInProject(
  task: SSHLifecycleTask,
  caseMarker: string,
): Promise<void> {
  const { projectScope } = task;
  if (projectScope && projectScope.workspaceIdentity !== task.identity)
    throw new Error(`${caseMarker}: task ${task.label} 与显式项目 identity 不匹配`);
  await waitForTaskRowInProject(task.taskId, task.workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: task ${task.label} 没有恢复到正确项目`,
    projectScope,
  });
  if (projectScope) {
    const observed = await browser.execute(
      (selector, taskTestId) => {
        const sections = document.querySelectorAll(selector);
        if (sections.length !== 1) throw new Error(`显式项目必须唯一，实际 ${sections.length}`);
        const section = sections[0]!;
        const rows = Array.from(section.querySelectorAll("[data-testid]")).filter(
          (row) => row.getAttribute("data-testid") === taskTestId,
        );
        if (rows.length !== 1) throw new Error(`显式项目内任务行必须唯一，实际 ${rows.length}`);
        return {
          projectId: section.getAttribute("data-project-id"),
          hostId: section.getAttribute("data-project-host"),
          workspaceIdentity: section.getAttribute("data-project-workspace-identity"),
          projectName: section.getAttribute("data-project-name"),
          sectionMatchCount: sections.length,
          taskMatchCount: rows.length,
          taskInProject: section.contains(rows[0]!),
        };
      },
      projectSectionSelector(task.workspacePath, projectScope),
      testId(TID_TASK_ITEM, task.taskId),
    );
    await recordSSHProjectScope({
      stage: "task-row-in-project",
      label: task.label,
      workspacePath: task.workspacePath,
      taskId: task.taskId,
      ...observed,
    });
  }
}

export async function prepareSSHLifecycle(
  caseMarker: string,
  options: SSHLifecycleProviderOptions = {},
): Promise<{
  config: SSHRuntimeConfig;
  initialHosts: Array<{ name: string; pid: number }>;
  provider: SSHLifecycleProvider;
}> {
  const config = readSSHRuntimeConfig(caseMarker);
  await prepareV4ConversationE2E({ skipProvider: true });
  const initialHosts = await readHostProcesses();
  expect(initialHosts).toHaveLength(1);
  const provider = await createSSHLifecycleProvider(config, caseMarker, options);
  return { config, initialHosts, provider };
}

export interface RemoteProcessIdentity {
  pid: number;
  ppid?: number;
  startTicks: number;
  cwd?: string;
}

export async function readRemoteCoreIdentity(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<{
  pid: number;
  supervisorPid: number;
  startTicks: number;
  state: string;
  generation: number;
}> {
  const statusResult = await runSSHCommand(config, 'cat "$HOME/.zcode/server/run/status.json"');
  if (statusResult.code !== 0) {
    throw new Error(`${caseMarker}: 读取远端 Core status 失败: ${statusResult.stderr}`);
  }
  const status = JSON.parse(statusResult.stdout) as {
    pid?: number;
    state?: string;
    generation?: number;
  };
  const corePid = status.pid;
  if (typeof corePid !== "number" || !Number.isSafeInteger(corePid) || corePid <= 0) {
    throw new Error(`${caseMarker}: Core status 缺少有效 pid`);
  }
  const proc = await runSSHCommand(
    config,
    `pid=${corePid}; test -r /proc/$pid/stat && awk '{print $4" "$22}' /proc/$pid/stat`,
  );
  const [supervisorText, startTicksText] = proc.stdout.trim().split(/\s+/u);
  const supervisorPid = Number.parseInt(supervisorText ?? "", 10);
  const startTicks = Number.parseInt(startTicksText ?? "", 10);
  if (!Number.isSafeInteger(supervisorPid) || !Number.isSafeInteger(startTicks)) {
    throw new Error(`${caseMarker}: Core /proc identity 不完整: ${proc.stdout.trim()}`);
  }
  return {
    pid: corePid,
    supervisorPid,
    startTicks,
    state: status.state ?? "unknown",
    generation: status.generation ?? 0,
  };
}

export async function listRemoteAgentProcesses(
  config: SSHConnectionConfig,
): Promise<Array<RemoteProcessIdentity & { cwd: string }>> {
  const { REMOTE_AGENT_PROCESS_SCAN, parseRemoteAgentProcessEvidence } =
    await import("./remote-agent-process-evidence.js");
  // 原 ps 子串会漏掉 process.title=zcode-cli 的真实 Agent，还会命中查询 shell 自身。
  // 只沿本 Core 的 UID/exe/代际边界识别；完整 cwd 留给 fault/hooks/soak/subagent 各自判断。
  let result: Awaited<ReturnType<typeof runSSHCommand>>;
  try {
    result = await runSSHCommand(config, REMOTE_AGENT_PROCESS_SCAN);
  } catch {
    throw new Error("Remote Agent evidence: scan-failed");
  }
  if (result.code !== 0) throw new Error("Remote Agent evidence: scan-failed");
  return parseRemoteAgentProcessEvidence(result.stdout);
}

export async function terminateRemoteProcess(
  config: SSHConnectionConfig,
  process: RemoteProcessIdentity,
  caseMarker: string,
): Promise<void> {
  const current = await runSSHCommand(
    config,
    `test -r /proc/${process.pid}/stat && awk '{print $22}' /proc/${process.pid}/stat || true`,
  );
  if (Number.parseInt(current.stdout.trim(), 10) !== process.startTicks) return;
  const killed = await runSSHCommand(config, `kill -TERM -- ${process.pid}`);
  if (killed.code !== 0)
    throw new Error(`${caseMarker}: 终止远端进程 ${process.pid} 失败: ${killed.stderr}`);
  await browser.waitUntil(
    async () =>
      (
        await runSSHCommand(
          config,
          `test -r /proc/${process.pid}/stat && awk '{print $22}' /proc/${process.pid}/stat || true`,
        )
      ).stdout.trim() !== String(process.startTicks),
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: 远端进程 ${process.pid} 没有退出`,
    },
  );
}
