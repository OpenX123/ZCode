import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { createExternalEnginePort } from "@zcode/adapters/exec";
import {
  createSessionId,
  SessionEventType,
  type PermissionBrokerRequest,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import {
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import { projectSessionSubagents } from "../src/zcode-protocol/subagent-session-query.js";

// 真实形状帧（只读核查 codex-acp 2.2.2 / claude-agent-acp 0.95.0 的发帧代码后构造）经受控 ACP 进程
// 走真实 adapter → Runtime → SQLite → V4 投影；规则见 docs/desktop/external-agent-engines-spec.md。
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "native-subagents");
const roots: string[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  // 先关 adapter 进程（cwd 在临时目录内）再关 SQLite，Windows 才能删除临时目录。
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Engine = "codex" | "claude-code";

async function setup(engine: Engine, frames: string) {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-subagents-"));
  roots.push(root);
  const runtimeInfo = EXTERNAL_ENGINE_RUNTIMES[engine];
  const entry = join(
    root,
    managedAdapterInstallDirName(runtimeInfo),
    ...managedAdapterEntrySegments(runtimeInfo),
  );
  await mkdir(dirname(entry), { recursive: true });
  await copyFile(join(fixtures, "acp-fixture.cjs"), entry);
  const log = join(root, "client-messages.jsonl");
  const env = {
    ...process.env,
    [EXTERNAL_ENGINES_DIR_ENV]: root,
    [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
    ZCODE_DATA_BASE_DIR: root,
    FIXTURE_FRAMES: join(fixtures, frames),
    FIXTURE_LOG: log,
  };
  const sessionStore = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
  closers.push(() => sessionStore.close());
  const eventStore = createInMemorySessionEventStore();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return {
    root,
    workspace,
    sessionStore,
    eventStore,
    port: () => createExternalEnginePort({ env, executable: process.execPath }),
    async clientMessages(): Promise<Array<Record<string, unknown>>> {
      const text = await readFile(log, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

function createRuntime(
  context: Awaited<ReturnType<typeof setup>>,
  engine: Engine,
  sessionId: SessionId,
  port = context.port(),
) {
  const events: SessionEvent[] = [];
  const permissions: PermissionBrokerRequest[] = [];
  const runtime = new AgentRuntime(
    sessionId,
    { engine, workingDirectory: context.workspace },
    {
      eventStore: context.eventStore,
      sessionStore: context.sessionStore,
      modelFactory: () => {
        throw new Error("Provider must not run");
      },
      externalEnginePort: port,
      eventSink: { onSessionEvent: async (event) => void events.push(event) },
      permissionBroker: {
        requestPermission: async (request: PermissionBrokerRequest) => {
          permissions.push(request);
          return { decision: "allow" as const };
        },
      },
    },
  );
  closers.push(() => runtime.closeBrowserSession());
  return { runtime, events, permissions, port };
}

function projectionOf(sessionId: string, events: readonly SessionEvent[]) {
  const projection = new ProductProjection(sessionId, `test-${sessionId}`);
  for (const event of events) if (String(event.sessionId) === sessionId) projection.applyEvent(event);
  return projection;
}

function childIdOf(events: readonly SessionEvent[], agentId: string): string {
  const spawned = events.find(
    (event) =>
      event.type === SessionEventType.SubagentSpawned &&
      (event.payload as { agentId?: string }).agentId === agentId,
  );
  return String((spawned?.payload as { childSessionId?: string }).childSessionId);
}

describe("外部引擎原生子智能体映射为 YCode 子会话", () => {
  it("Codex AIR 形态：子会话先落库再进入 snapshot.subagents，正文、嵌套、重开、权限与冷恢复一致", async () => {
    const context = await setup("codex", "codex-air.json");
    const sessionId = createSessionId();
    const { runtime, events, permissions } = createRuntime(context, "codex", sessionId);
    await runtime.executeTurn("检查鉴权性能");

    const childId = childIdOf(events, "019a7c00-0000-7000-8000-0000child0001");
    const grandchildId = childIdOf(events, "019a7c00-0000-7000-8000-0000grandkid01");
    const reopenedId = childIdOf(events, "019a7c00-0000-7000-8000-0000child0001:generation:2");
    expect(new Set([childId, grandchildId, reopenedId]).size).toBe(3);

    // 子会话记录：subagent_child、直接父会话、原生名称；不保存原生会话 ID。
    const child = await context.sessionStore.getSession(childId as SessionId);
    expect(child).toMatchObject({
      taskType: "subagent_child",
      parentID: sessionId,
      title: "Engine perf auth",
      engine: "codex",
    });
    expect(child?.externalSessionId).toBeUndefined();
    expect(await context.sessionStore.getSession(grandchildId as SessionId)).toMatchObject({
      taskType: "subagent_child",
      parentID: childId,
    });

    // 事件顺序：子会话首个持久化事件早于父会话 SubagentSpawned。
    const childFirst = events.findIndex((event) => String(event.sessionId) === childId);
    const parentSpawn = events.findIndex(
      (event) =>
        String(event.sessionId) === sessionId &&
        event.type === SessionEventType.SubagentSpawned &&
        (event.payload as { childSessionId?: string }).childSessionId === childId,
    );
    expect(childFirst).toBeGreaterThanOrEqual(0);
    expect(childFirst).toBeLessThan(parentSpawn);
    // 嵌套子会话的 SubagentSpawned 发在直接父子会话上。
    expect(
      events.some(
        (event) =>
          String(event.sessionId) === childId &&
          event.type === SessionEventType.SubagentSpawned &&
          (event.payload as { childSessionId?: string }).childSessionId === grandchildId,
      ),
    ).toBe(true);

    // 子会话正文：首条 user = task，思考 / 工具 / 正文进入子会话自己的 message/part。
    const childMessages = await context.sessionStore.messages({ sessionID: childId as SessionId });
    const parts = childMessages.flatMap((message) => message.parts);
    expect(childMessages[0]?.info.role).toBe("user");
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "检查鉴权路径的耗时" }),
        expect.objectContaining({ type: "reasoning", text: "先搜索鉴权入口" }),
        expect.objectContaining({ type: "text", text: "鉴权耗时集中在 checkAuth。" }),
        expect.objectContaining({
          type: "tool",
          tool: "Run rg auth",
          state: expect.objectContaining({ status: "completed" }),
        }),
      ]),
    );
    expect(
      events.some(
        (event) =>
          String(event.sessionId) === childId &&
          event.type === SessionEventType.ExternalEngineUsageUpdated,
      ),
    ).toBe(true);
    // 父会话正文不含子会话文字。
    const parentText = (await context.sessionStore.messages({ sessionID: sessionId }))
      .flatMap((message) => message.parts)
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    expect(parentText).not.toContain("checkAuth");

    // 子会话权限回到父会话待处理交互并标注来源，应答原样回原生 optionId；未知子会话回 cancelled。
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      sessionId,
      origin: { kind: "subagent", childSessionId: childId, parentSessionId: sessionId },
    });
    const responses = (await context.clientMessages()).filter(
      (message) => message.method === undefined && message.result !== undefined,
    );
    expect(responses.map((message) => (message.result as { outcome?: unknown }).outcome)).toEqual(
      expect.arrayContaining([
        { outcome: "selected", optionId: "approved" },
        { outcome: "cancelled" },
      ]),
    );
    // 未知子 ID 不建记录、不产生事件。
    const children = await context.sessionStore.listSessions({ taskTypes: ["subagent_child"] });
    expect(children.map((session) => session.id).sort()).toEqual(
      [childId, grandchildId, reopenedId].sort(),
    );
    expect(JSON.stringify(events)).not.toContain("不应出现");
    // Codex 未声明 cancel：不提供 Stop。
    expect(events.some((event) => event.type === SessionEventType.BackgroundTaskStarted)).toBe(
      false,
    );

    // live 投影：父会话两条直属子会话（含 generation:2），嵌套不进根目录；结束后 running 为空。
    let peakRunning = 0;
    let firstRunning: unknown;
    const live = new ProductProjection(sessionId, "live");
    for (const event of events) {
      if (String(event.sessionId) !== sessionId) continue;
      live.applyEvent(event);
      const running = live.getSnapshot().subagents?.running ?? [];
      firstRunning ??= running[0];
      peakRunning = Math.max(peakRunning, running.length);
    }
    expect(peakRunning).toBe(1);
    // 运行项：原生名称为标题，toolCallId 指向父会话合成的 Agent 行，界面据此下钻。
    expect(firstRunning).toMatchObject({
      childSessionId: childId,
      agentId: "019a7c00-0000-7000-8000-0000child0001",
      title: "Engine perf auth",
      status: "running",
      toolCallId: "native-subagent:019a7c00-0000-7000-8000-0000child0001:1",
    });
    expect(
      live
        .getSnapshot()
        .rows.window.some(
          (row) =>
            row.kind === "toolCall" &&
            row.toolCallId === "native-subagent:019a7c00-0000-7000-8000-0000child0001:1",
        ),
    ).toBe(true);
    expect(live.getSnapshot().subagents).toMatchObject({
      childSessionIds: [childId, reopenedId],
      running: [],
      endedTotal: 2,
    });
    const agentRow = live
      .getSnapshot()
      .rows.window.find((row) => row.kind === "subagent" && row.childSessionId === childId);
    // 运行中标题为原生名称，结束后摘要为子会话最终正文。
    expect(agentRow).toMatchObject({ status: "success", summaryText: "鉴权耗时集中在 checkAuth。" });
    expect(
      live
        .getSnapshot()
        .rows.window.find((row) => row.kind === "subagent" && row.childSessionId === reopenedId),
    ).toMatchObject({ status: "failed" });
    // 子会话可按 childSessionId 订阅：子 topic 投影出正文。
    expect(JSON.stringify(projectionOf(childId, events).getSnapshot().rows.window)).toContain(
      "鉴权耗时集中在 checkAuth。",
    );

    // 冷恢复：只凭持久化 transcript 重建父会话 Agent 行与目录、子会话正文。
    const parentMessages = await context.sessionStore.messages({ sessionID: sessionId });
    const cold = new ProductProjection(sessionId, "cold");
    for (const event of synthesizeEventsFromMessages(parentMessages, { sessionId }))
      cold.applyEvent(event);
    expect(cold.getSnapshot().subagents).toMatchObject({
      childSessionIds: [childId, reopenedId],
      running: [],
      endedTotal: 2,
    });
    const coldChild = new ProductProjection(childId, "cold-child");
    for (const event of synthesizeEventsFromMessages(childMessages, { sessionId: childId }))
      coldChild.applyEvent(event);
    expect(JSON.stringify(coldChild.getSnapshot().rows.window)).toContain("鉴权耗时集中在 checkAuth。");

    // 已结束分页查询沿用同一 Agent 行。
    const parentSession = (await context.sessionStore.getSession(sessionId))!;
    const childSessions = new Map(
      await Promise.all(
        [childId, reopenedId].map(
          async (id) => [id, (await context.sessionStore.getSession(id as SessionId))!] as const,
        ),
      ),
    );
    const query = projectSessionSubagents({
      revision: 1,
      parentSession,
      messages: parentMessages,
      childSessionsById: childSessions,
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });
    expect(query.running).toEqual([]);
    expect(query.ended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ childSessionId: childId, status: "success" }),
        expect.objectContaining({ childSessionId: reopenedId, status: "failed" }),
      ]),
    );
    await runtime.closeBrowserSession();

    // 重启：session/load 回放子会话帧不写任何新行；子会话冷恢复不启动 adapter。
    const childMessageCount = childMessages.length;
    const restarted = createRuntime(context, "codex", sessionId);
    await restarted.runtime.resumeFromStore();
    expect(
      (await context.clientMessages()).some((message) => message.method === "session/load"),
    ).toBe(true);
    expect(
      (await context.sessionStore.messages({ sessionID: childId as SessionId })).length,
    ).toBe(childMessageCount);
    expect(restarted.events.some((event) => event.type === SessionEventType.SubagentSpawned)).toBe(
      false,
    );
    await restarted.runtime.closeBrowserSession();
    const initializesBefore = (await context.clientMessages()).filter(
      (message) => message.method === "initialize",
    ).length;
    const childRuntime = createRuntime(context, "codex", childId as SessionId);
    await childRuntime.runtime.resumeFromStore();
    expect(
      (await context.clientMessages()).filter((message) => message.method === "initialize").length,
    ).toBe(initializesBefore);
  });

  it("Claude RFD 形态：委派提示作为子会话首条消息，可取消子会话经原生 session/cancel 停止，父轮结束时未结束的记 lost", async () => {
    const context = await setup("claude-code", "claude-rfd.json");
    const sessionId = createSessionId();
    const { runtime, events } = createRuntime(context, "claude-code", sessionId);
    const turn = runtime.executeTurn("查鉴权");
    const runnerId = await vi.waitFor(
      () => {
        const started = events.find(
          (event) =>
            event.type === SessionEventType.BackgroundTaskStarted &&
            (event.payload as { description?: string }).description === "Runner (general-purpose)",
        );
        expect(started).toBeDefined();
        return String((started!.payload as { childSessionId: string }).childSessionId);
      },
      { timeout: 10_000 },
    );
    expect(await runtime.cancelBackgroundTask(runnerId)).toMatchObject({ cancelled: true });
    await turn;

    expect(
      (await context.clientMessages()).some(
        (message) =>
          message.method === "session/cancel" &&
          (message.params as { sessionId?: string }).sessionId === "f0e1d2c3b4a596870",
      ),
    ).toBe(true);
    const explorerId = childIdOf(events, "a1b2c3d4e5f6a7b8c");
    const watcherId = childIdOf(events, "99aa88bb77cc66dd5");
    const explorerMessages = await context.sessionStore.messages({
      sessionID: explorerId as SessionId,
    });
    expect(explorerMessages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "找出鉴权检查的位置" }),
    ]);
    // 父会话自己的发送视图不写入任何正文；提示只出现一次。
    expect(
      explorerMessages.flatMap((message) => message.parts).filter(
        (part) => part.type === "text" && part.text === "找出鉴权检查的位置",
      ),
    ).toHaveLength(1);

    const stopped = events
      .filter((event) => event.type === SessionEventType.SubagentStopped)
      .map((event) => event.payload as { childSessionId: string; status: string });
    expect(stopped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ childSessionId: explorerId, status: "completed" }),
        expect.objectContaining({ childSessionId: runnerId, status: "cancelled" }),
        expect.objectContaining({ childSessionId: watcherId, status: "lost" }),
      ]),
    );
    // Watcher 未声明 cancel，不提供 Stop。
    expect(
      events.some(
        (event) =>
          event.type === SessionEventType.BackgroundTaskStarted &&
          (event.payload as { childSessionId?: string }).childSessionId === watcherId,
      ),
    ).toBe(false);
    const snapshot = projectionOf(sessionId, events).getSnapshot();
    expect(snapshot.subagents).toMatchObject({ running: [], endedTotal: 3 });
    expect(snapshot.backgroundWorks.filter((work) => work.status === "running")).toEqual([]);
    expect(
      snapshot.rows.window.find((row) => row.kind === "subagent" && row.childSessionId === runnerId),
    ).toMatchObject({ status: "cancelled" });
    // 结束后停止：不可再取消。
    expect(await runtime.cancelBackgroundTask(runnerId)).toMatchObject({ cancelled: false });
    await runtime.closeBrowserSession();
  });
});
