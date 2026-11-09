// 外部引擎进程池：预建会话（spare）与闲置连接关闭（docs/desktop/external-agent-engines-spec.md P04–P07、P09、P13）。
// 真实 stdio 子进程 + 磁盘调用日志（含 pid），验证进程归属而非模拟内部实现。
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  createRootTraceContext,
  type ExternalEngineTurnInput,
  type LogContext,
  type Logger,
} from "@zcode/contracts";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  EXTERNAL_ENGINES_DIR_ENV,
  EXTERNAL_ENGINE_USER_HOME_ENV,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared";
import {
  createExternalEnginePort,
  createExternalEngineConfigCatalog,
  createExternalEngineProcessPool,
  type ExternalEngineConfigCatalog,
  type ExternalEngineProcessPoolOptions,
} from "../src/external-engine/index.js";
import type { AcpConnection } from "../src/external-engine/connection.js";
import * as sharedNode from "@zcode/shared/node";
import { createSharedZCodeCredentialStore } from "../src/auth/index.js";

// 严格关闭在 Windows 读取真实 CIM 进程树；测试预算需覆盖产品的 10 秒失败边界。
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

function controlledConnection() {
  const warming = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let closed = false;
  const connection = {
    get healthy() {
      return !closed;
    },
    async prebuild() {
      started.resolve();
      await warming.promise;
    },
    async close() {
      closed = true;
      warming.resolve();
    },
  } as unknown as AcpConnection;
  return { connection, warming, started, isClosed: () => closed };
}

describe("warming 独占与所有权", () => {
  const key = { engine: "codex" as const, connectionProfileId: "codex:inherit", cwd: tmpdir() };
  test("迟到 launch 关闭失败不能释放许可或成功 ACK，随后允许重试", async () => {
    const launch = Promise.withResolvers<AcpConnection>();
    const started = Promise.withResolvers<void>();
    let requestId = "",
      released = false,
      failClose = true;
    const pool = createExternalEngineProcessPool({
      budget: {
        acquire: async (id) => {
          requestId = id;
          return true;
        },
        release: async () => {
          released = true;
        },
      },
    });
    pool.refillSpare(key, () => {
      started.resolve();
      return launch.promise;
    });
    await started.promise;
    const revoked = pool.revokeSpare(requestId);
    launch.resolve({
      healthy: true,
      prebuild: async () => {},
      close: async () => {
        if (failClose) throw new Error("fixture tree still alive");
      },
    } as unknown as AcpConnection);
    try {
      await expect(revoked).rejects.toThrow("fixture tree still alive");
      expect(released).toBe(false);
      failClose = false;
      await pool.revokeSpare(requestId);
      expect(released).toBe(true);
    } finally {
      failClose = false;
      await pool.close();
    }
  });
  test("许可尚未答复时前台 miss，不等待 Host 预算", async () => {
    const grant = Promise.withResolvers<boolean>();
    const pool = createExternalEngineProcessPool({
      budget: { acquire: () => grant.promise, release: async () => {} },
    });
    const target = controlledConnection();
    pool.refillSpare(key, async () => target.connection);
    let completed = false;
    const claimed = pool.claimSpare(key).then((value) => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    const didComplete = completed;
    grant.resolve(false);
    await claimed;
    await pool.close();
    expect(didComplete).toBe(true);
  });
  test("release 回复丢失不阻塞已就绪前台交付", async () => {
    const release = Promise.withResolvers<void>();
    const pool = createExternalEngineProcessPool({
      budget: { acquire: async () => true, release: () => release.promise },
    });
    const target = controlledConnection();
    target.warming.resolve();
    pool.refillSpare(key, async () => target.connection);
    await target.started.promise;
    let completed = false;
    const claimed = pool.claimSpare(key).then((value) => {
      completed = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const didComplete = completed;
    release.resolve();
    await claimed;
    await pool.close();
    await target.connection.close();
    expect(didComplete).toBe(true);
  });
  test("撤销 warming 必须等进程 close gate 才释放许可与 ACK", async () => {
    const close = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const warm = Promise.withResolvers<void>();
    let requestId = "",
      released = false,
      acked = false;
    const pool = createExternalEngineProcessPool({
      budget: {
        acquire: async (id) => {
          requestId = id;
          return true;
        },
        release: async () => {
          released = true;
        },
      },
    });
    pool.refillSpare(
      key,
      async () =>
        ({
          healthy: true,
          prebuild: async () => {
            started.resolve();
            await warm.promise;
          },
          close: async () => {
            warm.resolve();
            await close.promise;
          },
        }) as unknown as AcpConnection,
    );
    await started.promise;
    const revoke = pool.revokeSpare(requestId).then(() => {
      acked = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const earlyRelease = released,
      earlyAck = acked;
    close.resolve();
    await revoke;
    await pool.close();
    expect(earlyRelease).toBe(false);
    expect(earlyAck).toBe(false);
    expect(released).toBe(true);
  });
  test("warming 第一请求独占等待，第二请求 miss，交付后不随 pool.close 关闭", async () => {
    const pool = createExternalEngineProcessPool();
    const target = controlledConnection();
    pool.refillSpare(key, async () => target.connection);
    await target.started.promise;
    const first = pool.claimSpare(key);
    expect(await pool.claimSpare(key)).toBeUndefined();
    target.warming.resolve();
    expect((await first)?.connection).toBe(target.connection);
    await pool.close();
    expect(target.isClosed()).toBe(false);
    await target.connection.close();
  });
  test("取消已预留的 warming 会关闭连接，不交付也不遗留", async () => {
    const pool = createExternalEngineProcessPool();
    const target = controlledConnection();
    pool.refillSpare(key, async () => target.connection);
    await target.started.promise;
    const controller = new AbortController();
    const claimed = pool.claimSpare(key, controller.signal);
    controller.abort();
    expect(await claimed).toBeUndefined();
    expect(target.isClosed()).toBe(true);
    await pool.close();
  });
  test("close 等待已摘索引 reservation 的迟到 spawn，并关闭它", async () => {
    const pool = createExternalEngineProcessPool();
    const launch = Promise.withResolvers<AcpConnection>();
    const target = controlledConnection();
    pool.refillSpare(key, () => launch.promise);
    const claimed = pool.claimSpare(key);
    const closing = pool.close();
    launch.resolve(target.connection);
    await closing;
    expect(await claimed).toBeUndefined();
    expect(target.isClosed()).toBe(true);
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Engine = "claude-code" | "codex";
interface FixtureSettings {
  gateSpare?: boolean;
  slowInitAfterFirstMs?: number;
  /** session/new 响应延迟；用来区分冷启动与领用预建会话的 sessionMs。 */
  slowSessionNewMs?: number;
  /** 原生新会话的初始模式；"default" 时 Claude 新会话应被切到 Auto。 */
  initialMode?: string;
  /** session/new 响应前发一条通知、响应后稍晚再发一条，模拟领用前到达的初始通知。 */
  notify?: boolean;
}
const fixture = (settings: FixtureSettings) => String.raw`
const fs=require('node:fs'), path=require('node:path'), readline=require('node:readline');
const settings=${JSON.stringify(settings)}, log=path.join(process.env.HOME,'calls.jsonl');
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
const update=(sessionId,u)=>send({method:'session/update',params:{sessionId,update:u}});
let counter=0, prompt, spare=false;
const options=[
 {id:'mode',name:'Mode',currentValue:settings.initialMode||'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'},{value:'default',name:'Default'},{value:'auto',name:'Auto'}]},
 {id:'model',name:'Model',currentValue:'a',options:[{value:'a',name:'A'},{value:'b',name:'B'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(!f.method){ if(f.id===900) send({id:prompt.id,result:{stopReason:'end_turn'}}); return; }
 const before=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 fs.appendFileSync(log,JSON.stringify({pid:process.pid,method:f.method,sessionId:f.params?.sessionId,configId:f.params?.configId,value:f.params?.value})+'\n');
 if(f.method==='initialize'){
  spare=before.filter(x=>x.method==='initialize').length===1;
  const delay=settings.slowInitAfterFirstMs&&before.some(x=>x.method==='initialize')?settings.slowInitAfterFirstMs:0;
  setTimeout(()=>send({id:f.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}}}),delay);
 } else if(f.method==='session/new'){
  const id='ext-'+process.pid+'-'+(++counter);
  const respond=()=>{
   if(settings.notify){
    update(id,{sessionUpdate:'available_commands_update',availableCommands:[{name:'early',description:'early'}]});
    setTimeout(()=>update(id,{sessionUpdate:'session_info_update',title:'late-'+id}),30);
   }
   send({id:f.id,result:{sessionId:id,configOptions:options}});
  };
  if(settings.gateSpare&&spare&&!fs.existsSync(path.join(process.env.HOME,'allow-spare'))){
   const watcher=fs.watch(process.env.HOME,()=>{if(fs.existsSync(path.join(process.env.HOME,'allow-spare'))){watcher.close();respond();}});
  } else setTimeout(respond,settings.slowSessionNewMs||0);
 }
 else if(f.method==='session/resume') send({id:f.id,result:{sessionId:f.params.sessionId,configOptions:options}});
 else if(f.method==='session/set_config_option'){options.find(o=>o.id===f.params.configId).currentValue=f.params.value; send({id:f.id,result:{configOptions:options}});}
 else if(f.method==='session/prompt'){
  if(f.params.prompt[0].text==='hold'){prompt=f; send({id:900,method:'session/request_permission',params:{sessionId:f.params.sessionId,toolCall:{toolCallId:'t'},options:[{optionId:'deny',kind:'reject_once',name:'Deny'}]}}); return;}
  send({id:f.id,result:{stopReason:'end_turn'}});
 }
});`;

interface Call {
  pid: number;
  method: string;
  sessionId?: string;
  configId?: string;
  value?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingLogger() {
  const events: Array<{ level: string; context: LogContext }> = [];
  const logger: Logger = {
    debug: () => {},
    info: (_message, context = {}) => events.push({ level: "info", context }),
    warn: (_message, context = {}) => events.push({ level: "warn", context }),
    error: () => {},
    child: () => logger,
  };
  const named = (event: string) => events.filter((item) => item.context.event === event);
  return { logger, events, named };
}

async function setup(
  engines: Engine[],
  poolOptions: ExternalEngineProcessPoolOptions = {},
  settings: FixtureSettings = {},
  portOptions: { configCatalog?: ExternalEngineConfigCatalog } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-acp-pool-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const engine of engines) {
    const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
    const entry = join(
      root,
      managedAdapterInstallDirName(descriptor),
      ...managedAdapterEntrySegments(descriptor),
    );
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, fixture(settings));
  }
  const log = recordingLogger();
  const pool = createExternalEngineProcessPool({ logger: log.logger, ...poolOptions });
  cleanups.push(() => pool.close());
  const env = {
    ...process.env,
    [EXTERNAL_ENGINES_DIR_ENV]: root,
    [EXTERNAL_ENGINE_USER_HOME_ENV]: root,
    ZCODE_DATA_BASE_DIR: root,
  };
  // 每个会话 app 各自一个 port，同 CLI 进程共享同一个池。
  const openPort = (sessionId: string) => {
    const port = createExternalEnginePort({
      env,
      executable: process.execPath,
      processPool: pool,
      logger: log.logger,
      ...portOptions,
    });
    cleanups.push(() => port.closeSession(sessionId));
    return port;
  };
  const calls = async (): Promise<Call[]> => {
    try {
      return (await readFile(join(root, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { root, env, pool, log, openPort, calls };
}

function input(
  sessionId: string,
  engine: Engine,
  extra: Partial<ExternalEngineTurnInput> = {},
): ExternalEngineTurnInput {
  return {
    sessionId,
    engine,
    cwd: tmpdir(),
    signal: new AbortController().signal,
    traceContext: createRootTraceContext(),
    prompt: [{ type: "text", text: "example" }],
    async onSession() {},
    async onConfigOptions() {},
    async onUpdate() {},
    async requestPermission() {
      return { outcome: "cancelled" };
    },
    ...extra,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("预建会话（spare）", () => {
  test("pool 交付后 port 接收前取消仍关闭已领用进程", async () => {
    const { env, pool, log, openPort, calls } = await setup(["codex"]);
    await openPort("seed").prepareSession(input("seed", "codex"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const pid = (await calls()).filter((c) => c.method === "initialize")[1]!.pid;
    const controller = new AbortController();
    const port = createExternalEnginePort({
      env,
      executable: process.execPath,
      processPool: {
        ...pool,
        claimSpare(key, signal) {
          const result = pool.claimSpare(key, signal);
          void result.then(() => controller.abort());
          return result;
        },
      },
    });
    cleanups.push(() => port.closeSession("cancel-transfer"));
    await expect(
      port.prepareSession(input("cancel-transfer", "codex", { signal: controller.signal })),
    ).rejects.toThrow();
    const survived = alive(pid);
    // 旧实现会漏掉已经移交、但尚未登记进 sessions 的连接；清理测试泄漏后再断言。
    if (survived) process.kill(pid);
    expect(survived).toBe(false);
  });
  test("ready hit 前重新检查凭据，删除密钥不能领用现存备用", async () => {
    const { root, env, log, openPort } = await setup(["claude-code"]);
    const store = createSharedZCodeCredentialStore({ env });
    await store.save("fixture-key", "fixture-secret");
    await writeFile(
      join(root, "connections.json"),
      JSON.stringify({
        activeProfileId: "inherit",
        lastUsed: { "claude-code": "profile-a" },
        profiles: [
          {
            id: "profile-a",
            engine: "claude-code",
            mode: "apiKey",
            credentialKey: "fixture-key",
            hasApiKey: true,
          },
        ],
      }),
    );
    await openPort("seed").prepareSession(input("seed", "claude-code"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    await store.delete("fixture-key");
    await expect(
      openPort("next").prepareSession(input("next", "claude-code")),
    ).rejects.toMatchObject({ failure: { code: "authentication" } });
    expect(log.named("external_engine.spare.claimed")).toHaveLength(0);
  });
  test("同 ID profile 内容变更拒绝旧备用", async () => {
    const { root, log, openPort, calls } = await setup(["claude-code"]);
    const writeProfile = (model: string) =>
      writeFile(
        join(root, "connections.json"),
        JSON.stringify({
          activeProfileId: "inherit",
          lastUsed: { "claude-code": "profile-a" },
          profiles: [{ id: "profile-a", engine: "claude-code", mode: "official", model }],
        }),
      );
    await writeProfile("before");
    await openPort("seed").prepareSession(input("seed", "claude-code"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const oldPid = (await calls()).filter((c) => c.method === "initialize")[1]!.pid;
    await writeProfile("after");
    let native = "";
    await openPort("next").prepareSession(
      input("next", "claude-code", {
        async onSession(id) {
          native = id;
        },
      }),
    );
    expect(native).not.toBe(`ext-${oldPid}-1`);
    expect(log.named("external_engine.spare.miss").at(-1)?.context.reason).toBe("generation");
  });
  test("warming gate：第一新会话等待备用，第二新会话冷启且原生 ID 不同", async () => {
    const { root, log, openPort, calls } = await setup(["codex"], {}, { gateSpare: true });
    await openPort("seed").prepareSession(input("seed", "codex"));
    await vi.waitFor(async () =>
      expect((await calls()).filter((c) => c.method === "session/new")).toHaveLength(2),
    );
    const sparePid = (await calls()).filter((c) => c.method === "session/new")[1]!.pid;
    let firstId = "";
    const first = openPort("first").prepareSession(
      input("first", "codex", {
        async onSession(id) {
          firstId = id;
        },
      }),
    );
    // 身份读取完成后，claimed 日志前仍处于 reservation wait；用第二请求的完成与 PID 证明互斥。
    await vi.waitFor(() => expect(log.named("external_engine.spare.reserved")).toHaveLength(1));
    let secondId = "";
    await openPort("second").prepareSession(
      input("second", "codex", {
        async onSession(id) {
          secondId = id;
        },
      }),
    );
    expect(firstId).toBe("");
    expect(secondId).not.toBe(`ext-${sparePid}-1`);
    await writeFile(join(root, "allow-spare"), "ready");
    await first;
    expect(firstId).toBe(`ext-${sparePid}-1`);
    expect(firstId).not.toBe(secondId);
  });
  test("安装入口替换后旧 ready 备用不得交付", async () => {
    const { root, log, openPort, calls } = await setup(["codex"]);
    await openPort("seed").prepareSession(input("seed", "codex"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((c) => c.method === "initialize")[1]!.pid;
    const runtime = EXTERNAL_ENGINE_RUNTIMES.codex;
    await writeFile(
      join(root, managedAdapterInstallDirName(runtime), ...managedAdapterEntrySegments(runtime)),
      fixture({}) + "\n// replacement",
    );
    let native = "";
    await openPort("next").prepareSession(
      input("next", "codex", {
        async onSession(id) {
          native = id;
        },
      }),
    );
    expect(native).not.toBe(`ext-${sparePid}-1`);
    expect(alive(sparePid)).toBe(false);
  });
  test("ready hit 十次均不遍历 PATH，补位复用一次解析结果且原生 ID 独立", async () => {
    const resolver = vi.spyOn(sharedNode, "resolveExternalEngineLaunch");
    try {
      const { log, openPort, calls } = await setup(["codex"]);
      const ids = new Set<string>();
      await openPort("cold").prepareSession(input("cold", "codex"));
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
      const resolved = resolver.mock.calls.length;
      for (let index = 0; index < 10; index++) {
        const id = `hit-${index}`;
        await openPort(id).prepareSession(
          input(id, "codex", {
            async onSession(native) {
              ids.add(native);
            },
          }),
        );
        await vi.waitFor(() =>
          expect(log.named("external_engine.spare.ready")).toHaveLength(index + 2),
        );
      }
      expect(resolver.mock.calls.length - resolved).toBe(0);
      expect(ids.size).toBe(10);
      expect((await calls()).filter((call) => call.method === "initialize")).toHaveLength(12);
    } finally {
      resolver.mockRestore();
    }
  });
  test.each(["claude-code", "codex"] as const)(
    "%s 同配置第二个新会话领用预建会话并在后台补位，至多一个（P04）",
    async (engine) => {
      const { log, openPort, calls } = await setup([engine]);
      await openPort("s1").prepareSession(input("s1", engine));
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
      const initialized = (await calls()).filter((call) => call.method === "initialize");
      expect(initialized).toHaveLength(2);
      const sparePid = initialized[1]!.pid;
      expect(log.named("external_engine.spare.miss")[0]?.context.reason).toBe("none");
      // 预建会话在补位时就完成了该 cwd 的 session/new，但从未提交 prompt。
      expect(
        (await calls()).filter((call) => call.pid === sparePid).map((call) => call.method),
      ).toEqual(["initialize", "session/new"]);

      await openPort("s2").prepareSession(input("s2", engine));
      const afterClaim = await calls();
      // 领用时备用进程上既不重复 initialize，也不再 session/new。
      expect(
        afterClaim.filter((call) => call.method === "initialize" && call.pid === sparePid),
      ).toHaveLength(1);
      expect(
        afterClaim.filter((call) => call.method === "session/new" && call.pid === sparePid),
      ).toHaveLength(1);
      expect(log.named("external_engine.spare.claimed")).toHaveLength(1);
      expect(log.named("external_engine.handshake.completed").at(-1)?.context).toMatchObject({
        spare: "hit",
        method: "session/new",
      });
      // 领用后补位一个新的预建会话，不会多于一个。
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(2));
      await sleep(100);
      expect((await calls()).filter((call) => call.method === "initialize")).toHaveLength(3);
      expect((await calls()).filter((call) => call.method === "session/new")).toHaveLength(3);
      expect((await calls()).some((call) => call.method === "session/prompt")).toBe(false);
    },
  );

  test.each([
    ["claude-code", ["initialize", "session/new", "session/set_config_option:mode=auto"], "auto"],
    ["codex", ["initialize", "session/new"], "default"],
  ] as const)(
    "%s 领用预建会话：取得预建 ID 与配置，已保存配置领用后下发，领用前通知交给会话（P09）",
    async (engine, prebuildCalls, prebuiltMode) => {
      const { log, openPort, calls } = await setup(
        [engine],
        {},
        { initialMode: "default", notify: true, slowSessionNewMs: 300 },
      );
      await openPort("s1").prepareSession(input("s1", engine));
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
      const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
      const prebuiltId = `ext-${sparePid}-1`;
      const describeCall = (call: Call) =>
        call.method === "session/set_config_option"
          ? `${call.method}:${call.configId}=${call.value}`
          : call.method;
      // 预建：initialize → session/new →（仅 Claude 新会话）Auto 默认；不发 prompt。
      expect((await calls()).filter((call) => call.pid === sparePid).map(describeCall)).toEqual(
        prebuildCalls,
      );
      // 等预建会话响应之后的通知也到达（它们只能缓冲，交给日后的领用会话）。
      await sleep(150);
      const spareCallsBeforeClaim = (await calls()).filter((call) => call.pid === sparePid).length;

      let sessionId: string | undefined;
      const published: Array<Array<{ id: string; currentValue: string }>> = [];
      const updates: Array<Record<string, unknown>> = [];
      const port = openPort("s2");
      const claimInput = (extra: Partial<ExternalEngineTurnInput> = {}) =>
        input("s2", engine, {
          configValues: [{ id: "model", value: "b" }],
          async onSession(id) {
            sessionId = id;
          },
          async onConfigOptions(options) {
            published.push(options);
          },
          async onUpdate(update) {
            updates.push(update);
          },
          ...extra,
        });
      await port.prepareSession(claimInput());

      expect(sessionId).toBe(prebuiltId);
      // 领用后预建进程上只有会话自带的已保存配置，没有 initialize / session/new。
      expect(
        (await calls())
          .filter((call) => call.pid === sparePid)
          .slice(spareCallsBeforeClaim)
          .map(describeCall),
      ).toEqual(["session/set_config_option:model=b"]);
      expect(published.at(-1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "mode", currentValue: prebuiltMode }),
          expect.objectContaining({ id: "model", currentValue: "b" }),
        ]),
      );
      // 领用前到达的通知（session/new 响应前后）按初始通知缓冲规则交给领用会话。
      expect(updates.map((update) => update.sessionUpdate)).toEqual([
        "available_commands_update",
        "session_info_update",
      ]);
      expect(updates[1]).toMatchObject({ title: `late-${prebuiltId}` });

      const handshakes = log.named("external_engine.handshake.completed");
      expect(handshakes[0]?.context).toMatchObject({ spare: "miss", method: "session/new" });
      expect(Number(handshakes[0]?.context.sessionMs)).toBeGreaterThanOrEqual(250);
      expect(handshakes.at(-1)?.context).toMatchObject({
        spare: "hit",
        method: "session/new",
        initializeMs: 0,
      });
      expect(Number(handshakes.at(-1)?.context.sessionMs)).toBeLessThan(250);

      // 补位后至多一个。
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(2));
      await sleep(100);
      expect((await calls()).filter((call) => call.method === "session/new")).toHaveLength(3);

      // 领用后的连接与冷启动无区别：prompt 直接发在预建的原生会话上。
      await port.runTurn(claimInput({ externalSessionId: sessionId }));
      expect((await calls()).filter((call) => call.method === "session/prompt")).toEqual([
        expect.objectContaining({ pid: sparePid, sessionId: prebuiltId }),
      ]);
    },
  );

  test("Claude 领用时已确认的模式按原恢复规则覆盖预建的 Auto 默认（P09）", async () => {
    const { log, openPort, calls } = await setup(["claude-code"], {}, { initialMode: "default" });
    await openPort("s1").prepareSession(input("s1", "claude-code"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    const before = (await calls()).filter((call) => call.pid === sparePid).length;
    let published: Array<{ id: string; currentValue: string }> = [];
    await openPort("s2").prepareSession(
      input("s2", "claude-code", {
        configValues: [{ id: "mode", value: "default" }],
        async onConfigOptions(options) {
          published = options;
        },
      }),
    );
    expect(log.named("external_engine.spare.claimed")).toHaveLength(1);
    expect(
      (await calls())
        .filter((call) => call.pid === sparePid)
        .slice(before)
        .map((call) => [call.method, call.configId, call.value]),
    ).toEqual([["session/set_config_option", "mode", "default"]]);
    expect(published.find((option) => option.id === "mode")?.currentValue).toBe("default");
  });

  test("预建会话进程已退出时按未命中冷启动", async () => {
    const { log, openPort, calls } = await setup(["codex"]);
    await openPort("s1").prepareSession(input("s1", "codex"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    process.kill(sparePid);
    await vi.waitFor(() => expect(alive(sparePid)).toBe(false));
    await sleep(50);
    let sessionId: string | undefined;
    await openPort("s2").prepareSession(
      input("s2", "codex", {
        async onSession(id) {
          sessionId = id;
        },
      }),
    );
    expect(log.named("external_engine.spare.miss").at(-1)?.context.reason).toBe("unhealthy");
    expect(log.named("external_engine.spare.claimed")).toHaveLength(0);
    expect(sessionId).not.toBe(`ext-${sparePid}-1`);
  });

  test("预建会话不跨连接配置复用", async () => {
    const { log, openPort, calls } = await setup(["claude-code"]);
    await openPort("s1").prepareSession(
      input("s1", "claude-code", { connectionProfileId: "inherit" }),
    );
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    let sessionId: string | undefined;
    await openPort("s2").prepareSession(
      input("s2", "claude-code", {
        connectionProfileId: "official",
        async onSession(id) {
          sessionId = id;
        },
      }),
    );
    expect(log.named("external_engine.spare.claimed")).toHaveLength(0);
    expect(log.named("external_engine.spare.miss").at(-1)?.context).toMatchObject({
      connectionProfileId: "official",
      reason: "none",
    });
    // 预建进程上只有补位时自己的那次 session/new，其他配置的会话没有拿到它的原生会话。
    expect(
      (await calls()).filter((call) => call.method === "session/new" && call.pid === sparePid),
    ).toHaveLength(1);
    expect(sessionId).not.toBe(`ext-${sparePid}-1`);
  });

  test("恢复原会话不领用备用进程", async () => {
    const { log, openPort, calls } = await setup(["codex"]);
    await openPort("s1").prepareSession(input("s1", "codex"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    await openPort("s2").prepareSession(input("s2", "codex", { externalSessionId: "ext-old" }));
    const resumed = (await calls()).find((call) => call.method === "session/resume");
    expect(resumed?.pid).not.toBe(sparePid);
    expect(log.named("external_engine.spare.claimed")).toHaveLength(0);
  });

  test("未领用的备用进程到期关闭，之后新会话冷启动", async () => {
    const { log, openPort, calls } = await setup(["codex"], { spareIdleMs: 150 });
    await openPort("s1").prepareSession(input("s1", "codex"));
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    await vi.waitFor(() => expect(log.named("external_engine.spare.expired")).toHaveLength(1));
    await vi.waitFor(() => expect(alive(sparePid)).toBe(false), { timeout: 10_000 });
    await openPort("s2").prepareSession(input("s2", "codex"));
    expect(log.named("external_engine.spare.miss").at(-1)?.context.reason).toBe("none");
  });

  test("关闭进程池结束就绪与仍在初始化的备用进程，此后不再补位", async () => {
    const { pool, log, openPort, calls } = await setup(
      ["claude-code", "codex"],
      {},
      {
        slowInitAfterFirstMs: 400,
      },
    );
    await openPort("s1").prepareSession(input("s1", "codex"));
    await vi.waitFor(async () =>
      expect((await calls()).filter((call) => call.method === "initialize")).toHaveLength(2),
    );
    const warmingPid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    await pool.close();
    await vi.waitFor(() => expect(alive(warmingPid)).toBe(false));
    expect(log.named("external_engine.spare.ready")).toHaveLength(0);
    expect(log.named("external_engine.spare.failed")).toHaveLength(0);
    await openPort("s2").prepareSession(input("s2", "claude-code"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // s2 冷启动 1 个进程；关闭后的池不再补位。
    expect((await calls()).filter((call) => call.method === "initialize")).toHaveLength(3);
  });
});

describe("闲置连接关闭", () => {
  const later = () => Date.now() + 20 * 60 * 1_000;

  test.each(["claude-code", "codex"] as const)(
    "%s 关闭空闲 adapter 后下一轮按原会话恢复已确认配置，prompt 只发一次",
    async (engine) => {
      const { pool, log, openPort, calls } = await setup([engine], { now: later });
      const port = openPort("s1");
      let externalSessionId: string | undefined;
      const turn = () =>
        input("s1", engine, {
          externalSessionId,
          configValues: [{ id: "mode", value: "fast" }],
          async onSession(id) {
            externalSessionId = id;
          },
        });
      await port.runTurn(turn());
      await port.setConfigOption("s1", "mode", "fast");
      const firstPid = (await calls()).find((call) => call.method === "session/prompt")!.pid;
      const originalId = externalSessionId;

      await pool.sweepIdle();
      expect(log.named("external_engine.idle_close")).toHaveLength(1);
      expect(port.isSessionConnected?.("s1")).toBe(false);
      await vi.waitFor(() => expect(alive(firstPid)).toBe(false));

      await port.runTurn(turn());
      const all = await calls();
      expect(externalSessionId).toBe(originalId);
      expect(all.filter((call) => call.method === "session/prompt")).toHaveLength(2);
      const resumed = all.filter((call) => call.method === "session/resume");
      expect(resumed).toEqual([expect.objectContaining({ sessionId: originalId })]);
      expect(
        all.filter(
          (call) => call.method === "session/set_config_option" && call.pid === resumed[0]!.pid,
        ),
      ).toEqual([expect.objectContaining({ value: "fast" })]);
      expect(log.named("external_engine.idle_resume.completed")).toHaveLength(1);
    },
  );

  // 2026-11-08 用户决策：取消“每个 CLI 最近 3 个可恢复会话”豁免，只豁免当前可见的会话
  // （扫描证据：发过 prompt 的会话 1.48GB 五天 0 次 idle_close）。
  test("不可见的会话闲置 15 分钟后关闭，只豁免可见会话；可见集合按连接整体替换并取并集", async () => {
    const { pool, log, openPort } = await setup(["codex"], { now: later });
    const ports = new Map<string, ReturnType<typeof openPort>>();
    for (const id of ["s1", "s2", "s3", "s4"]) {
      const port = openPort(id);
      await port.runTurn(input(id, "codex"));
      ports.set(id, port);
    }
    const connected = () =>
      [...ports].filter(([id, port]) => port.isSessionConnected?.(id)).map(([id]) => id);
    pool.setVisibleSessions("conn-a", ["s2"]);
    pool.setVisibleSessions("conn-b", ["s3"]);
    await pool.sweepIdle();
    expect(connected()).toEqual(["s2", "s3"]);
    expect(
      log
        .named("external_engine.idle_close")
        .map((item) => [item.context.sessionId, item.context.kind]),
    ).toEqual([
      ["s1", "prompted"],
      ["s4", "prompted"],
    ]);

    // 同一连接再次上报是整体替换：conn-a 不再包含 s2；conn-b 的 s3 仍可见。
    pool.setVisibleSessions("conn-a", []);
    await pool.sweepIdle();
    expect(connected()).toEqual(["s3"]);
    // 连接关闭时以空集删除该连接的上报。
    pool.setVisibleSessions("conn-b", []);
    await pool.sweepIdle();
    expect(connected()).toEqual([]);
  });

  test("草稿闲置 10 分钟关闭，发过 prompt 的会话要满 15 分钟；未上报可见性按不可见", async () => {
    let offsetMs = 0;
    const { pool, log, openPort } = await setup(["codex"], {
      now: () => Date.now() + offsetMs,
    });
    const draft = openPort("draft");
    await draft.prepareSession(input("draft", "codex"));
    const prompted = openPort("s1");
    await prompted.runTurn(input("s1", "codex"));

    offsetMs = 9 * 60 * 1_000;
    await pool.sweepIdle();
    expect(draft.isSessionConnected?.("draft")).toBe(true);

    offsetMs = 11 * 60 * 1_000;
    await pool.sweepIdle();
    expect(draft.isSessionConnected?.("draft")).toBe(false);
    expect(prompted.isSessionConnected?.("s1")).toBe(true);

    offsetMs = 16 * 60 * 1_000;
    await pool.sweepIdle();
    expect(prompted.isSessionConnected?.("s1")).toBe(false);
    expect(
      log
        .named("external_engine.idle_close")
        .map((item) => [item.context.sessionId, item.context.kind]),
    ).toEqual([
      ["draft", "draft"],
      ["s1", "prompted"],
    ]);
  });

  test("可见的草稿不关闭", async () => {
    const { pool, openPort } = await setup(["codex"], { now: later });
    const draft = openPort("draft");
    await draft.prepareSession(input("draft", "codex"));
    pool.setVisibleSessions("conn-a", ["draft"]);
    await pool.sweepIdle();
    expect(draft.isSessionConnected?.("draft")).toBe(true);
  });

  // 从未提交 prompt 的原生会话可能无法 resume（两家未 prompt 的会话关闭后都不写原生历史），
  // 草稿关闭后的再准备必须是新的 session/new，并可领用同键预建会话。
  test.each(["claude-code", "codex"] as const)(
    "%s 草稿闲置关闭后再准备走 session/new（领用预建会话），不 resume，prompt 只发一次",
    async (engine) => {
      const { pool, log, openPort, calls } = await setup([engine], { now: later });
      const port = openPort("draft");
      let externalSessionId: string | undefined;
      const draftInput = (extra: Partial<ExternalEngineTurnInput> = {}) =>
        input("draft", engine, {
          externalSessionId,
          configValues: [{ id: "mode", value: "fast" }],
          async onSession(id) {
            externalSessionId = id;
          },
          ...extra,
        });
      await port.prepareSession(draftInput());
      const draftNativeId = externalSessionId;
      // 新会话就绪后后台补位一个预建会话。
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));

      await pool.sweepIdle();
      expect(port.isSessionConnected?.("draft")).toBe(false);
      expect(log.named("external_engine.idle_close")[0]?.context.kind).toBe("draft");

      await port.runTurn(draftInput());
      const all = await calls();
      expect(all.filter((call) => call.method === "session/resume")).toEqual([]);
      expect(all.filter((call) => call.method === "session/load")).toEqual([]);
      expect(log.named("external_engine.spare.claimed")).toHaveLength(1);
      expect(externalSessionId).toBeDefined();
      expect(externalSessionId).not.toBe(draftNativeId);
      const prompts = all.filter((call) => call.method === "session/prompt");
      expect(prompts).toEqual([expect.objectContaining({ sessionId: externalSessionId })]);
      // 草稿已确认的配置在新原生会话上恢复。
      expect(
        all.filter(
          (call) =>
            call.method === "session/set_config_option" &&
            call.pid === prompts[0]!.pid &&
            call.value === "fast",
        ),
      ).toHaveLength(1);
    },
  );

  test("草稿 adapter 进程退出后的再准备同样走 session/new；发过 prompt 之后才按原会话 resume", async () => {
    const { openPort, calls } = await setup(["codex"]);
    const port = openPort("draft");
    let externalSessionId: string | undefined;
    const draftInput = () =>
      input("draft", "codex", {
        externalSessionId,
        async onSession(id) {
          externalSessionId = id;
        },
      });
    await port.prepareSession(draftInput());
    const draftPid = (await calls()).find((call) => call.method === "session/new")!.pid;
    process.kill(draftPid);
    await vi.waitFor(() => expect(port.isSessionConnected?.("draft")).toBe(false));

    const draftNativeId = externalSessionId;
    await port.runTurn(draftInput());
    let all = await calls();
    expect(all.filter((call) => call.method === "session/resume")).toEqual([]);
    expect(externalSessionId).not.toBe(draftNativeId);
    const promptedId = externalSessionId;
    const promptPid = all.find((call) => call.method === "session/prompt")!.pid;
    expect(all.filter((call) => call.method === "session/prompt")).toEqual([
      expect.objectContaining({ sessionId: promptedId }),
    ]);

    // 提交过 prompt 后原生会话已落盘：进程退出后按原会话 resume。
    process.kill(promptPid);
    await vi.waitFor(() => expect(port.isSessionConnected?.("draft")).toBe(false));
    await port.runTurn(draftInput());
    all = await calls();
    expect(all.filter((call) => call.method === "session/resume")).toEqual([
      expect.objectContaining({ sessionId: promptedId }),
    ]);
    expect(externalSessionId).toBe(promptedId);
  });

  test("运行中（等待权限）的会话不关闭，结束后才可关闭", async () => {
    const { pool, log, openPort } = await setup(["codex"], { now: later });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const busy = openPort("busy");
    const running = busy.runTurn(
      input("busy", "codex", {
        prompt: [{ type: "text", text: "hold" }],
        async requestPermission() {
          waiting();
          await gate;
          return { outcome: "cancelled" };
        },
      }),
    );
    await started;
    await pool.sweepIdle();
    expect(busy.isSessionConnected?.("busy")).toBe(true);
    expect(log.named("external_engine.idle_close")).toHaveLength(0);
    release();
    await running;
    await pool.sweepIdle();
    expect(busy.isSessionConnected?.("busy")).toBe(false);
  });
});

// W4：每个外部引擎各 1 个窗口许可（Host 拥有许可，pool 申请时带 engine）；拒绝必须留日志。
describe("按引擎备用许可（W4，P15）", () => {
  const base = { connectionProfileId: "inherit", cwd: tmpdir() };
  /** 模拟 Host 合同：每个引擎各 1 个许可，窗口至多 2 个。 */
  function perEngineBudget() {
    const held = new Map<string, string>();
    const calls: Array<{ requestId: string; engine: string | undefined }> = [];
    return {
      calls,
      held,
      budget: {
        acquire: async (requestId: string, _signal: AbortSignal, engine?: string) => {
          calls.push({ requestId, engine });
          const permitKey = engine ?? "legacy";
          if (held.has(permitKey) || held.size >= 2) return false;
          held.set(permitKey, requestId);
          return true;
        },
        release: async (requestId: string) => {
          for (const [permitKey, id] of held) if (id === requestId) held.delete(permitKey);
        },
      },
    };
  }

  test("申请带 engine；Codex 备用持有许可时 Claude 补位仍获许可，两者都可领用", async () => {
    const host = perEngineBudget();
    const log = recordingLogger();
    const pool = createExternalEngineProcessPool({ budget: host.budget, logger: log.logger });
    const codex = controlledConnection();
    const claude = controlledConnection();
    codex.warming.resolve();
    claude.warming.resolve();
    pool.refillSpare({ ...base, engine: "codex" }, async () => codex.connection);
    await codex.started.promise;
    pool.refillSpare({ ...base, engine: "claude-code" }, async () => claude.connection);
    await claude.started.promise;
    expect(host.calls.map((call) => call.engine)).toEqual(["codex", "claude-code"]);
    expect(log.named("external_engine.spare.refill_denied")).toHaveLength(0);
    expect((await pool.claimSpare({ ...base, engine: "claude-code" }))?.connection).toBe(
      claude.connection,
    );
    expect((await pool.claimSpare({ ...base, engine: "codex" }))?.connection).toBe(
      codex.connection,
    );
    await pool.close();
    await codex.connection.close();
    await claude.connection.close();
  });

  test("同引擎第二个许可被拒：记 info refill_denied，不 spawn，前台 miss", async () => {
    const host = perEngineBudget();
    const log = recordingLogger();
    const pool = createExternalEngineProcessPool({ budget: host.budget, logger: log.logger });
    const first = controlledConnection();
    first.warming.resolve();
    pool.refillSpare({ ...base, engine: "codex" }, async () => first.connection);
    await first.started.promise;
    let launched = false;
    pool.refillSpare({ ...base, engine: "codex", connectionProfileId: "other" }, async () => {
      launched = true;
      return controlledConnection().connection;
    });
    await vi.waitFor(() => expect(log.named("external_engine.spare.refill_denied")).toHaveLength(1));
    expect(log.named("external_engine.spare.refill_denied")[0]).toEqual({
      level: "info",
      context: expect.objectContaining({ engine: "codex", connectionProfileId: "other" }),
    });
    expect(launched).toBe(false);
    expect(
      await pool.claimSpare({ ...base, engine: "codex", connectionProfileId: "other" }),
    ).toBeUndefined();
    await pool.close();
  });
});

// W4：CLI 进程内存的选项清单缓存，键 =（引擎，连接配置，工作区身份 key，generation）。
describe("选项清单缓存（W4，P17）", () => {
  const options = [
    { id: "model", name: "Model", currentValue: "a", options: [{ value: "a", name: "A" }] },
  ];
  test("catalog 按四元键隔离，返回副本，超过上限淘汰最旧条目", () => {
    const catalog = createExternalEngineConfigCatalog({ maxEntries: 2 });
    const key = {
      engine: "claude-code" as const,
      connectionProfileId: "inherit",
      workspaceKey: "/w",
      generation: "g1",
    };
    catalog.remember(key, options);
    const hit = catalog.lookup(key);
    expect(hit).toEqual(options);
    hit![0]!.currentValue = "mutated";
    expect(catalog.lookup(key)).toEqual(options);
    expect(catalog.lookup({ ...key, generation: "g2" })).toBeUndefined();
    expect(catalog.lookup({ ...key, workspaceKey: "/other" })).toBeUndefined();
    expect(catalog.lookup({ ...key, connectionProfileId: "official" })).toBeUndefined();
    expect(catalog.lookup({ ...key, engine: "codex" })).toBeUndefined();
    catalog.remember({ ...key, generation: "g2" }, options);
    catalog.remember({ ...key, generation: "g3" }, options);
    expect(catalog.lookup(key)).toBeUndefined();
    expect(catalog.lookup({ ...key, generation: "g3" })).toEqual(options);
  });

  test("新会话在握手前收到上次确认的清单；不同工作区与 resume 不收到", async () => {
    const configCatalog = createExternalEngineConfigCatalog();
    const { openPort } = await setup(["codex"], {}, {}, { configCatalog });
    const order: string[] = [];
    const track = (label: string) => ({
      async onCachedConfigOptions(list: unknown[]) {
        order.push(`${label}:cached:${list.length}`);
      },
      async onConfigOptions(list: unknown[]) {
        order.push(`${label}:live:${list.length}`);
      },
    });
    await openPort("first").prepareSession(
      input("first", "codex", { workspaceKey: "/w", ...track("first") }),
    );
    await openPort("second").prepareSession(
      input("second", "codex", { workspaceKey: "/w", ...track("second") }),
    );
    await openPort("third").prepareSession(
      input("third", "codex", { workspaceKey: "/other", ...track("third") }),
    );
    let resumedId = "";
    await openPort("resumed").prepareSession(
      input("resumed", "codex", {
        workspaceKey: "/w",
        externalSessionId: "ext-existing",
        async onSession(id) {
          resumedId = id;
        },
        ...track("resumed"),
      }),
    );
    expect(resumedId).toBe("ext-existing");
    expect(order).toEqual([
      "first:live:2",
      "second:cached:2",
      "second:live:2",
      "third:live:2",
      "resumed:live:2",
    ]);
  });
});
