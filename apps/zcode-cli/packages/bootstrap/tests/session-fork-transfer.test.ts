import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ForkCommitBundle, SessionId } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionForkTransferSchema,
  type ZCodeProtocolMessage,
  type ZCodeSessionForkTransfer,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import { projectIdFromDirectory } from "../src/app/paths.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function request(server: ZCodeProtocolAgentServer, method: string, params: unknown) {
  const response = await server.handleMessage({
    id: "fork-transfer-test",
    method,
    params,
  } as ZCodeProtocolMessage);
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result;
}
function preferences(server: ZCodeProtocolAgentServer) {
  server.setNotificationSink((message) => {
    if (
      "id" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    ) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
      });
    }
  });
}
async function fixture() {
  const source = await createSqliteSessionStore({ dbPath: ":memory:" });
  const target = await createSqliteSessionStore({ dbPath: ":memory:" });
  cleanups.push(async () => {
    await source.close();
    await target.close();
  });
  const targetWorkspace = {
    workspacePath: "/fork/中文",
    workspaceIdentity: "target-identity",
    workspaceKey: "target-identity",
  };
  const parentId = "sess_transfer_parent" as SessionId;
  const childId = "sess_transfer_child" as SessionId;
  await source.createSession({
    id: parentId,
    engine: "codex",
    externalSessionId: "native-parent",
    projectID: projectIdFromDirectory("/source"),
    workspaceID: "/source" as never,
    slug: "source",
    title: "源会话",
    directory: "/source",
    path: "/source",
    version: "test",
    time: { created: 1, updated: 1 },
  });
  const bundle: ForkCommitBundle = {
    child: {
      id: childId,
      parentID: parentId,
      engine: "codex",
      externalSessionId: "native-child",
      projectID: projectIdFromDirectory(targetWorkspace.workspacePath),
      workspaceID: targetWorkspace.workspaceIdentity as never,
      slug: "child",
      title: "分叉会话",
      directory: targetWorkspace.workspacePath,
      path: targetWorkspace.workspacePath,
      version: "test",
      time: { created: 2, updated: 2 },
    },
    messages: [
      {
        info: {
          id: "msg_transfer_child" as never,
          sessionID: childId,
          role: "user",
          time: { created: 1 },
          agent: "codex",
          tools: {},
        },
        parts: [
          {
            id: "part_transfer_child" as never,
            sessionID: childId,
            messageID: "msg_transfer_child" as never,
            type: "text",
            text: "冻结的历史",
          },
        ],
      },
    ],
    entries: [
      {
        id: `${childId}:external-engine-config`,
        sessionID: childId,
        type: "external_engine_config",
        time: { created: 2, updated: 2 },
        data: { engine: "codex", engineConfigOptions: [], connectionProfileId: "original-profile" },
      },
    ],
    commandFact: {
      scope: "child",
      parentSessionId: parentId,
      sourceCommandId: "transfer-operation",
      ack: {
        commandId: "transfer-operation",
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: childId },
      },
      metadata: {},
    },
  };
  const exportFork = vi.fn(async () => ({
    bundle: structuredClone(bundle),
    forkKind: "native" as const,
  }));
  const sourceServer = new ZCodeProtocolAgentServer({
    cwd: "/source",
    version: "test",
    sessionStore: source,
    createZCodeApp(options) {
      const app = createFakeApp(options);
      return { ...app, runtime: { ...app.runtime, exportConversationFork: exportFork } as never };
    },
  });
  const targetOptions: ZCodeAppOptions[] = [];
  const targetServer = new ZCodeProtocolAgentServer({
    cwd: targetWorkspace.workspacePath,
    version: "test",
    sessionStore: target,
    createZCodeApp(options) {
      targetOptions.push(options);
      return createFakeApp(options);
    },
  });
  preferences(sourceServer);
  preferences(targetServer);
  cleanups.push(async () => {
    sourceServer.disposeProjections();
    targetServer.disposeProjections();
  });
  const transfer = zcodeSessionForkTransferSchema.parse(
    await request(sourceServer, zcodeProtocolMethods.sessionExportFork, {
      sessionId: parentId,
      operationId: "transfer-operation",
      workspace: targetWorkspace,
    }),
  );
  return {
    source,
    target,
    parentId,
    childId,
    bundle,
    sourceServer,
    targetServer,
    targetWorkspace,
    targetOptions,
    transfer,
    exportFork,
  };
}

describe("跨工作区 Fork 导出与原子导入", () => {
  test("父会话后来运行时仍将已完成操作交给runtime幂等重放", async () => {
    const f = await fixture();
    const context = (
      f.sourceServer as unknown as {
        context: { sessions: Map<string, { activeAbortController?: AbortController }> };
      }
    ).context;
    context.sessions.get(f.parentId)!.activeAbortController = new AbortController();
    const replay = await request(f.sourceServer, zcodeProtocolMethods.sessionExportFork, {
      sessionId: f.parentId,
      operationId: "transfer-operation",
      workspace: f.targetWorkspace,
    });
    expect(replay).toEqual(f.transfer);
    expect(f.exportFork).toHaveBeenCalledTimes(2);
  });

  test("冻结bundle跨独立数据库导入，保留引擎/原生ID/连接身份，重复请求只产生一个child", async () => {
    const f = await fixture();
    expect(f.transfer.sha256).toBe(createHash("sha256").update(f.transfer.payload).digest("hex"));
    expect(f.exportFork).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDirectory: f.targetWorkspace.workspacePath,
        targetWorkspaceId: "target-identity",
      }),
    );
    expect(await f.source.getSession(f.childId)).toBeNull();
    expect(await f.target.getSession(f.parentId)).toBeNull();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(f.targetServer, zcodeProtocolMethods.sessionImportFork, {
        transfer: f.transfer,
        workspace: f.targetWorkspace,
      });
      expect(result).toMatchObject({
        forkKind: "native",
        snapshot: { session: { sessionId: f.childId, engine: "codex" } },
      });
    }
    expect(await f.target.getSession(f.childId)).toMatchObject({
      parentID: f.parentId,
      engine: "codex",
      externalSessionId: "native-child",
      directory: f.targetWorkspace.workspacePath,
      workspaceID: "target-identity",
    });
    expect(
      (await f.target.messages({ sessionID: f.childId })).flatMap((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")),
      ),
    ).toEqual(["冻结的历史"]);
    expect(
      await f.target.sessionEntries!({ sessionID: f.childId, type: "external_engine_config" }),
    ).toMatchObject([{ data: { connectionProfileId: "original-profile" } }]);
    expect(f.targetOptions).toHaveLength(1);
    expect(f.targetOptions[0]!.runtimeConfig).toMatchObject({
      engine: "codex",
      externalSessionId: "native-child",
      workingDirectory: f.targetWorkspace.workspacePath,
    });
    expect(await f.target.getSession(f.parentId)).toBeNull();
  });

  test.each([
    "digest",
    "target-identity",
    "target-cwd",
    "bundle-child",
    "bundle-scope",
    "ack-child",
    "malformed-json",
    "native-id",
    "unknown-engine",
    "handoff-kind",
  ])("拒绝不匹配的%s且不留下半个child", async (scenario) => {
    const f = await fixture();
    const transfer: ZCodeSessionForkTransfer = structuredClone(f.transfer);
    const workspace = { ...f.targetWorkspace };
    if (scenario === "digest") transfer.payload += " ";
    else if (scenario === "target-identity") workspace.workspaceIdentity = "wrong-identity";
    else if (scenario === "target-cwd") workspace.workspacePath = "/wrong-directory";
    else {
      const bundle = JSON.parse(transfer.payload) as ForkCommitBundle;
      if (scenario === "bundle-child") bundle.child.id = "another-child" as SessionId;
      else if (scenario === "bundle-scope") delete bundle.commandFact.scope;
      else if (scenario === "ack-child")
        bundle.commandFact.ack.result.sessionId = "wrong-ack-child";
      else if (scenario === "native-id") delete bundle.child.externalSessionId;
      else if (scenario === "unknown-engine") bundle.child.engine = "unknown-engine" as never;
      else if (scenario === "handoff-kind") transfer.forkKind = "handoff";
      transfer.payload = scenario === "malformed-json" ? "{" : JSON.stringify(bundle);
      transfer.sha256 = createHash("sha256").update(transfer.payload).digest("hex");
    }
    const result = await f.targetServer.handleMessage({
      id: "bad-transfer",
      method: zcodeProtocolMethods.sessionImportFork,
      params: { transfer, workspace },
    });
    expect(result).toMatchObject({ error: { code: -32602 } });
    expect(await f.target.getSession(f.childId)).toBeNull();
    expect(f.targetOptions).toHaveLength(0);
  });

  test.each(["message", "part", "entry"] as const)(
    "全库%s主键冲突时拒绝传输，既有会话正文与身份不变",
    async (kind) => {
      const f = await fixture();
      const original = structuredClone(f.bundle.messages[0]!);
      original.info.sessionID = f.parentId;
      original.parts[0]!.sessionID = f.parentId;
      await f.target.createSession({
        ...f.bundle.child,
        id: f.parentId,
        parentID: undefined,
        directory: "/existing",
        path: "/existing",
      });
      await f.target.saveMessage(original.info);
      await f.target.savePart(original.parts[0]!);
      await f.target.saveSessionEntry!({
        ...f.bundle.entries[0]!,
        sessionID: f.parentId,
        data: { source: true },
      });
      const before = {
        session: await f.target.getSession(f.parentId),
        messages: await f.target.messages({ sessionID: f.parentId }),
        entries: await f.target.sessionEntries!({ sessionID: f.parentId }),
      };
      const transfer = structuredClone(f.transfer);
      const bundle = JSON.parse(transfer.payload) as ForkCommitBundle;
      if (kind !== "message") {
        bundle.messages[0]!.info.id = "unique-child-message" as never;
        bundle.messages[0]!.parts[0]!.messageID = "unique-child-message" as never;
      }
      if (kind !== "part") bundle.messages[0]!.parts[0]!.id = "unique-child-part" as never;
      if (kind !== "entry") bundle.entries[0]!.id = "unique-child-entry";
      transfer.payload = JSON.stringify(bundle);
      transfer.sha256 = createHash("sha256").update(transfer.payload).digest("hex");
      const result = await f.targetServer.handleMessage({
        id: "conflicting-transfer",
        method: zcodeProtocolMethods.sessionImportFork,
        params: { transfer, workspace: f.targetWorkspace },
      });
      expect(result).toHaveProperty("error");
      expect(await f.target.getSession(f.childId)).toBeNull();
      expect(f.targetOptions).toHaveLength(0);
      expect({
        session: await f.target.getSession(f.parentId),
        messages: await f.target.messages({ sessionID: f.parentId }),
        entries: await f.target.sessionEntries!({ sessionID: f.parentId }),
      }).toEqual(before);
    },
  );
});
