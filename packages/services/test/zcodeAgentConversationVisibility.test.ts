import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
} from "../src/zcode-agent/zcodeAgent.js";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  withTrustedZCodeAgentV4Connection,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import {
  ZCodeProtocolClient,
  mayRequestHostSessions,
} from "../src/zcode-agent/zcodeProtocolClient.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// docs/desktop/engine-performance-1.1-spec.md「会话可见性上报」VR05/VR06（P3 Host 转发）。

const createdDirs: string[] = [];
afterEach(() => {
  setDataBaseDir(null);
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLIENT_HELLO = {
  kind: "clientHello" as const,
  protocolVersion: 3 as const,
  clientId: "renderer-1",
  appVersion: "4.0.0",
};

function setupFacadeBase() {
  const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const base = {
    reportConversationVisibilityV4: vi.fn(async () => {}),
    setConnectionFlowStateV4: vi.fn(async () => {}),
    onAgentRuntimeLifecycle: vi.fn((listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) =>
      lifecycle.event(listener),
    ),
  } as unknown as IZCodeAgentService;
  return { base, lifecycle };
}

function lifecycleEvent(
  workspacePath: string,
  state: ZCodeAgentRuntimeLifecycleEvent["state"],
): ZCodeAgentRuntimeLifecycleEvent {
  return {
    workspacePath,
    workspaceKey: workspacePath,
    runtimeIdentity: { generation: 2, identity: `${workspacePath}:2:1`, processId: 1 },
    state,
  } as ZCodeAgentRuntimeLifecycleEvent;
}

describe("连接 facade 转发可见性上报", () => {
  it("VR05：握手后注入本连接 connectionId，剥离 Renderer 传入值；超过 64 个拒绝；关闭时发 closed", async () => {
    const { base } = setupFacadeBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-window-1",
      clientMode: "desktop-continuous",
    });
    await expect(
      scope.service.reportConversationVisibilityV4({
        workspacePath: "/repo",
        visibleSessionIds: ["s1"],
      }),
    ).rejects.toThrow("fault.connection.handshakeRequired");

    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4(CLIENT_HELLO);
    await scope.service.reportConversationVisibilityV4({
      workspacePath: "/repo",
      visibleSessionIds: ["s1", "s2"],
      connectionId: "forged",
    } as never);
    const forwarded = vi.mocked(base.reportConversationVisibilityV4).mock.calls[0]![0];
    expect(readTrustedZCodeAgentV4Connection(forwarded)?.connectionId).toBe("conn-window-1");
    expect(forwarded).not.toHaveProperty("connectionId");
    expect(forwarded).toMatchObject({ workspacePath: "/repo", visibleSessionIds: ["s1", "s2"] });

    await expect(
      scope.service.reportConversationVisibilityV4({
        workspacePath: "/repo",
        visibleSessionIds: Array.from({ length: 65 }, (_, index) => `s${index}`),
      }),
    ).rejects.toThrow();
    expect(base.reportConversationVisibilityV4).toHaveBeenCalledTimes(1);

    // 没有订阅、只收过可见性上报的工作区，连接关闭时也要发 closed，让 CLI 删除该连接集合。
    await scope.dispose();
    const closed = vi
      .mocked(base.setConnectionFlowStateV4)
      .mock.calls.map(([params]) => params)
      .filter((params) => params.state === "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ workspacePath: "/repo" });
    expect(readTrustedZCodeAgentV4Connection(closed[0])?.connectionId).toBe("conn-window-1");
  });

  it("VR05：该工作区 runtime unavailable 后撤销登记，关闭时不为它发 closed", async () => {
    const { base, lifecycle } = setupFacadeBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-window-1",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4(CLIENT_HELLO);
    await scope.service.reportConversationVisibilityV4({
      workspacePath: "/repo",
      visibleSessionIds: ["s1"],
    });
    lifecycle.fire(lifecycleEvent("/repo", "unavailable"));
    await scope.dispose();
    expect(base.setConnectionFlowStateV4).not.toHaveBeenCalled();
  });
});

/** 记录收到的每个请求，并对所有请求应答（session/list 返回空列表）。 */
const RECORDING_FAKE_AGENT = `
const { appendFileSync } = require("node:fs");
const log = process.argv[2];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  appendFileSync(log, JSON.stringify({ method: request.method, params: request.params }) + "\\n");
  const result = request.method === "session/list" ? { sessions: [] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`;

function createRecordingSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-visibility-"));
  createdDirs.push(dir);
  const scriptPath = join(dir, "recording-agent.cjs");
  const logPath = join(dir, "requests.log");
  writeFileSync(scriptPath, RECORDING_FAKE_AGENT);
  writeFileSync(logPath, "");
  return {
    dir,
    logPath,
    command: { command: process.execPath, args: [scriptPath, logPath], cwd: dir },
  };
}

function createReadyService(options: Parameters<typeof createZCodeAgentService>[0]) {
  return createZCodeAgentService({
    modelSelectionReadinessSource: {
      async getView() {
        return {
          revision: 1,
          providers: [
            {
              providerId: "glm",
              config: {
                kind: "api" as const,
                api: {
                  type: "openai-chat-completions" as const,
                  baseUrl: "https://provider.test/v1",
                },
                models: ["glm-4.6"],
              },
              models: [{ modelId: "glm-4.6", config: {} }],
            },
          ],
          // 夹具只需满足就绪判定；完整 ModelSelectionView 字段与本测试无关。
        } as never;
      },
    },
    ...options,
  });
}

describe("窗口外部引擎备用许可", () => {
  it.each(["unsupported", "remote-identity", "remote-session"] as const)(
    "%s 不提前准备且拒绝备用申请",
    async (scope) => {
      const sandbox = createRecordingSandbox();
      setDataBaseDir(sandbox.dir);
      writeFileSync(
        sandbox.command.args[0]!,
        String.raw`
const fs=require('node:fs'),log=process.argv[2];const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(f)+'\n');
 if(f.method==='session/list')send({id:'denied',method:'externalEngine/acquireSpare',params:{requestId:'r'}});
 if(f.method)send({id:f.id,result:f.method==='session/list'?{sessions:[]}: {}});
});`,
      );
      const select = vi.fn(async () => [
        {
          engine: "codex" as const,
          connectionProfileId: "inherit",
        },
      ]);
      const service = createReadyService({
        commandResolver: () => sandbox.command,
        externalEnginesSupported: scope !== "unsupported",
        selectExternalEngineSpares: select,
      });
      try {
        await service.listSessions({
          workspacePath: sandbox.dir,
          ...(scope === "remote-identity"
            ? {
                workspaceIdentity: buildServerRemoteWorkspaceIdentity({
                  serverId: "fixture",
                  workspacePath: sandbox.dir,
                }),
              }
            : {}),
          ...(scope === "remote-session" ? { remoteSessionId: "fixture-remote" } : {}),
        });
        await vi.waitFor(() =>
          expect(readFileSync(sandbox.logPath, "utf8")).toContain('"id":"denied","result":{}'),
        );
        expect(select).not.toHaveBeenCalled();
        expect(readFileSync(sandbox.logPath, "utf8")).not.toContain("externalEngine/prepareSpare");
      } finally {
        await service.disposeAllAndWait();
      }
    },
  );
  it("旧 client 迟到释放不能清掉当前许可；同申请重放幂等，非法载荷拒绝", async () => {
    const sandbox = createRecordingSandbox();
    setDataBaseDir(sandbox.dir);
    writeFileSync(
      sandbox.command.args[0]!,
      String.raw`
const fs=require('node:fs'),path=require('node:path'),log=process.argv[2],dir=path.dirname(log);
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
let seen='';
fs.watch(dir,()=>{const file=path.join(dir,process.pid+'.json');if(!fs.existsSync(file))return;const raw=fs.readFileSync(file,'utf8');if(raw===seen)return;seen=raw;send(JSON.parse(raw));}).unref();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({pid:process.pid,...f})+'\n');
 if(f.method==='externalEngine/prepareSpare') {
  send({id:'acquire',method:'externalEngine/acquireSpare',params:{requestId:'same-request'}});
  send({id:f.id,result:{}});
 } else if(f.method) send({id:f.id,result:f.method==='session/list'?{sessions:[]}: {}});
});`,
    );
    const service = createReadyService({
      commandResolver: () => sandbox.command,
      externalEnginesSupported: true,
      selectExternalEngineSpares: async () => [{ engine: "codex", connectionProfileId: "inherit" }],
    });
    const rows = () =>
      readFileSync(sandbox.logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const command = (pid: number, id: string, method: string, params: unknown) =>
      writeFileSync(join(sandbox.dir, `${pid}.json`), JSON.stringify({ id, method, params }));
    try {
      await service.listSessions({ workspacePath: sandbox.dir });
      await vi.waitFor(() => expect(rows().filter((row) => row.result?.leaseId)).toHaveLength(1));
      const first = rows().find((row) => row.result?.leaseId)!;
      const secondDir = join(sandbox.dir, "second");
      mkdirSync(secondDir);
      await service.listSessions({ workspacePath: secondDir });
      await vi.waitFor(() => expect(rows().filter((row) => row.result?.leaseId)).toHaveLength(2));
      const second = rows().filter((row) => row.result?.leaseId)[1]!;
      command(first.pid, "old-release", "externalEngine/releaseSpare", {
        requestId: "same-request",
      });
      await vi.waitFor(() => expect(rows().find((row) => row.id === "old-release")).toBeDefined());
      command(second.pid, "replay", "externalEngine/acquireSpare", { requestId: "same-request" });
      await vi.waitFor(() =>
        expect(rows().find((row) => row.id === "replay")?.result).toEqual(second.result),
      );
      command(first.pid, "old-acquire", "externalEngine/acquireSpare", { requestId: "different" });
      await vi.waitFor(() =>
        expect(rows().find((row) => row.id === "old-acquire")?.result).toEqual({}),
      );
      command(second.pid, "bad", "externalEngine/acquireSpare", {
        requestId: "x",
        workspacePath: "forged",
      });
      await vi.waitFor(() =>
        expect(rows().find((row) => row.id === "bad")?.error.code).toBe(-32602),
      );
      await service.disposeWorkspace({ workspacePath: secondDir });
      // 进程树确实结束之后才能让新一代 CLI 取得名额。
      await service.listSessions({ workspacePath: secondDir });
      await vi.waitFor(() =>
        expect(rows().filter((row) => row.id === "acquire" && row.result?.leaseId)).toHaveLength(3),
      );
    } finally {
      await service.disposeAllAndWait();
    }
  });
  it("selector 在途关闭 workspace 时不投递迟到准备", async () => {
    const sandbox = createRecordingSandbox();
    setDataBaseDir(sandbox.dir);
    const choice = Promise.withResolvers<Array<{ engine: "codex"; connectionProfileId: string }>>();
    const selected = Promise.withResolvers<void>();
    const service = createReadyService({
      commandResolver: () => sandbox.command,
      externalEnginesSupported: true,
      selectExternalEngineSpares: async () => {
        selected.resolve();
        return choice.promise;
      },
    });
    try {
      await service.listSessions({ workspacePath: sandbox.dir });
      await selected.promise;
      await service.disposeWorkspace({ workspacePath: sandbox.dir });
      choice.resolve([{ engine: "codex", connectionProfileId: "inherit" }]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readFileSync(sandbox.logPath, "utf8")).not.toContain("externalEngine/prepareSpare");
    } finally {
      await service.disposeAllAndWait();
    }
  });
  it("只对已启动 CLI 提前准备；第二 workspace 先撤销旧许可", async () => {
    const sandbox = createRecordingSandbox();
    setDataBaseDir(sandbox.dir);
    const script = String.raw`
const fs=require('node:fs'), path=require('node:path'), log=process.argv[2];
let n=0, current;
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 fs.appendFileSync(log,JSON.stringify({pid:process.pid,...f})+'\n');
 if(f.method==='externalEngine/prepareSpare'){
  current='request-'+process.pid+'-'+(++n);
  send({id:'acquire-'+n,method:'externalEngine/acquireSpare',params:{requestId:current}});
  send({id:f.id,result:{}});
 } else if(f.method==='externalEngine/revokeSpare') {
  const gate=path.join(path.dirname(log),'revoke-ack');
  if(fs.existsSync(gate)) send({id:f.id,result:{}});
  else { const watch=fs.watch(path.dirname(log),()=>{if(fs.existsSync(gate)){watch.close();send({id:f.id,result:{}});}}); }
 } else if(f.method) send({id:f.id,result:f.method==='session/list'?{sessions:[]}: {}});
});`;
    writeFileSync(sandbox.command.args[0]!, script);
    const commandResolver = vi.fn(() => sandbox.command);
    const service = createReadyService({
      commandResolver,
      externalEnginesSupported: true,
      selectExternalEngineSpares: async () => [
        {
          engine: "codex",
          connectionProfileId: "codex:inherit",
        },
      ],
    });
    const rows = () =>
      readFileSync(sandbox.logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    try {
      expect(commandResolver).not.toHaveBeenCalled();
      await service.listSessions({ workspacePath: sandbox.dir });
      await vi.waitFor(() => expect(rows().filter((row) => row.result?.leaseId)).toHaveLength(1));
      const secondDir = join(sandbox.dir, "second");
      mkdirSync(secondDir);
      await service.listSessions({ workspacePath: secondDir });
      await vi.waitFor(() =>
        expect(rows().some((row) => row.method === "externalEngine/revokeSpare")).toBe(true),
      );
      expect(rows().filter((row) => row.result?.leaseId)).toHaveLength(1);
      expect(rows().filter((row) => row.method === "externalEngine/prepareSpare")).toHaveLength(1);
      writeFileSync(join(sandbox.dir, "revoke-ack"), "ready");
      await vi.waitFor(() => expect(rows().filter((row) => row.result?.leaseId)).toHaveLength(2));
      const log = rows();
      const revoke = log.findIndex((row) => row.method === "externalEngine/revokeSpare");
      const grants = log
        .map((row, index) => (row.result?.leaseId ? index : -1))
        .filter((index) => index >= 0);
      expect(revoke).toBeGreaterThan(grants[0]!);
      expect(revoke).toBeLessThan(grants[1]!);
      expect(commandResolver).toHaveBeenCalledTimes(2);
      expect(
        mayRequestHostSessions("externalEngine/prepareSpare", {
          engine: "codex",
          connectionProfileId: "codex:inherit",
        }),
      ).toBe(false);
    } finally {
      await service.disposeAllAndWait();
    }
  });
});

// W4（P15/P16）：Host 按外部引擎各授 1 个许可（窗口 ≤2）；预热集合变化时对当前 client 重新调度。
describe("按引擎备用许可与预热集合（W4）", () => {
  // CLI 夹具：每次 prepareSpare 以 engine 为 requestId 申请许可；另可经 <pid>.json 注入任意请求。
  const PER_ENGINE_AGENT = String.raw`
const fs=require('node:fs'),path=require('node:path'),log=process.argv[2],dir=path.dirname(log);
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
let seen='';
fs.watch(dir,()=>{const file=path.join(dir,process.pid+'.json');if(!fs.existsSync(file))return;const raw=fs.readFileSync(file,'utf8');if(raw===seen)return;seen=raw;send(JSON.parse(raw));}).unref();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({pid:process.pid,...f})+'\n');
 if(f.method==='externalEngine/prepareSpare'){
  send({id:'acquire-'+f.params.engine,method:'externalEngine/acquireSpare',params:{requestId:'req-'+f.params.engine,engine:f.params.engine}});
  send({id:f.id,result:{}});
 } else if(f.method) send({id:f.id,result:f.method==='session/list'?{sessions:[]}: {}});
});`;
  const rowsOf = (logPath: string) =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it("Codex 与 Claude 各得 1 个许可互不挤占；同引擎第二个申请被拒；缺 engine 按旧单键", async () => {
    const sandbox = createRecordingSandbox();
    setDataBaseDir(sandbox.dir);
    writeFileSync(sandbox.command.args[0]!, PER_ENGINE_AGENT);
    const service = createReadyService({
      commandResolver: () => sandbox.command,
      externalEnginesSupported: true,
      selectExternalEngineSpares: async () => [
        { engine: "codex", connectionProfileId: "inherit" },
        { engine: "claude-code", connectionProfileId: "inherit" },
      ],
    });
    const rows = () => rowsOf(sandbox.logPath);
    const command = (pid: number, id: string, method: string, params: unknown) =>
      writeFileSync(join(sandbox.dir, `${pid}.json`), JSON.stringify({ id, method, params }));
    try {
      await service.listSessions({ workspacePath: sandbox.dir });
      await vi.waitFor(() =>
        expect(
          rows()
            .filter((row) => row.result?.leaseId)
            .map((row) => row.id)
            .sort(),
        ).toEqual(["acquire-claude-code", "acquire-codex"]),
      );
      const pid = rows().find((row) => row.id === "acquire-codex")!.pid as number;
      command(pid, "second-codex", "externalEngine/acquireSpare", {
        requestId: "other-codex",
        engine: "codex",
      });
      await vi.waitFor(() =>
        expect(rows().find((row) => row.id === "second-codex")?.result).toEqual({}),
      );
      // 窗口已有 2 个许可：缺 engine 的旧申请也不能突破上限。
      command(pid, "legacy", "externalEngine/acquireSpare", { requestId: "legacy-request" });
      await vi.waitFor(() => expect(rows().find((row) => row.id === "legacy")?.result).toEqual({}));
      // Claude 备用被领用（release）后，Claude 补位重新获得 Claude 许可，Codex 许可不受影响。
      command(pid, "release-claude", "externalEngine/releaseSpare", {
        requestId: "req-claude-code",
      });
      await vi.waitFor(() =>
        expect(rows().find((row) => row.id === "release-claude")).toBeDefined(),
      );
      command(pid, "refill-claude", "externalEngine/acquireSpare", {
        requestId: "refill-claude",
        engine: "claude-code",
      });
      await vi.waitFor(() =>
        expect(rows().find((row) => row.id === "refill-claude")?.result?.leaseId).toBeTruthy(),
      );
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("预热集合变化后对当前 client 追加准备新引擎，已准备的引擎不重复", async () => {
    const sandbox = createRecordingSandbox();
    setDataBaseDir(sandbox.dir);
    writeFileSync(sandbox.command.args[0]!, PER_ENGINE_AGENT);
    let choices: Array<{ engine: "codex" | "claude-code"; connectionProfileId: string }> = [
      { engine: "codex", connectionProfileId: "inherit" },
    ];
    let notify: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const service = createReadyService({
      commandResolver: () => sandbox.command,
      externalEnginesSupported: true,
      selectExternalEngineSpares: async () => choices,
      watchExternalEngineSpareSelection: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    });
    const prepared = () =>
      rowsOf(sandbox.logPath)
        .filter((row) => row.method === "externalEngine/prepareSpare")
        .map((row) => row.params.engine);
    try {
      await service.listSessions({ workspacePath: sandbox.dir });
      await vi.waitFor(() => expect(prepared()).toEqual(["codex"]));
      choices = [...choices, { engine: "claude-code", connectionProfileId: "inherit" }];
      notify?.();
      await vi.waitFor(() => expect(prepared()).toEqual(["codex", "claude-code"]));
      notify?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(prepared()).toEqual(["codex", "claude-code"]);
      await vi.waitFor(() =>
        expect(rowsOf(sandbox.logPath).filter((row) => row.result?.leaseId)).toHaveLength(2),
      );
    } finally {
      await service.disposeAllAndWait();
    }
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("base service 转发可见性上报", () => {
  it("VR06：CLI 不在时不拉起；CLI 在时发 v4/conversation/visibility，且不阻止闲置回收", async () => {
    const { dir, logPath, command } = createRecordingSandbox();
    setDataBaseDir(dir);
    const commandResolver = vi.fn(() => command);
    const onExit = vi.fn();
    const service = createReadyService({
      commandResolver,
      processLifecycleReporter: {
        onSpawn: vi.fn(),
        onReady: vi.fn(),
        onExit,
        onError: vi.fn(),
      },
      sessionIdleTimeoutMs: 400,
    });
    const trusted = (visibleSessionIds: string[]) =>
      withTrustedZCodeAgentV4Connection(
        { workspacePath: dir, visibleSessionIds },
        { connectionId: "conn-window-1", clientMode: "desktop-continuous" },
      );
    try {
      await expect(service.reportConversationVisibilityV4(trusted(["s1"]))).rejects.toThrow();
      expect(commandResolver).not.toHaveBeenCalled();

      await service.listSessions({ workspacePath: dir });
      await service.reportConversationVisibilityV4(trusted(["s1"]));
      const requests = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: unknown });
      expect(requests.find((request) => request.method === "v4/conversation/visibility")).toEqual({
        method: "v4/conversation/visibility",
        params: { connectionId: "conn-window-1", visibleSessionIds: ["s1"] },
      });
      // 可见性上报既不置位"可能承载会话"，也不续期：只做过无会话读取的 CLI 照常回收。
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(commandResolver).toHaveBeenCalledTimes(1);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("VR06：未携带可信连接的上报被拒绝", async () => {
    const service = createReadyService({});
    try {
      await expect(
        service.reportConversationVisibilityV4({ workspacePath: "/repo", visibleSessionIds: [] }),
      ).rejects.toThrow("fault.visibility.connectionUntrusted");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("VR06：可见性方法列入无会话白名单", () => {
    expect(
      mayRequestHostSessions("v4/conversation/visibility", {
        connectionId: "c",
        visibleSessionIds: ["s1"],
      }),
    ).toBe(false);
    expect(ZCodeProtocolClient).toBeDefined();
  });
});
