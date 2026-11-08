// 外部引擎进程池：预建会话（spare）与闲置连接关闭（docs/desktop/external-agent-engines-spec.md P04–P07、P09）。
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
  createExternalEngineProcessPool,
  type ExternalEngineProcessPoolOptions,
} from "../src/external-engine/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Engine = "claude-code" | "codex";
interface FixtureSettings {
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
let counter=0, prompt;
const options=[
 {id:'mode',name:'Mode',currentValue:settings.initialMode||'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'},{value:'default',name:'Default'},{value:'auto',name:'Auto'}]},
 {id:'model',name:'Model',currentValue:'a',options:[{value:'a',name:'A'},{value:'b',name:'B'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(!f.method){ if(f.id===900) send({id:prompt.id,result:{stopReason:'end_turn'}}); return; }
 const before=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 fs.appendFileSync(log,JSON.stringify({pid:process.pid,method:f.method,sessionId:f.params?.sessionId,configId:f.params?.configId,value:f.params?.value})+'\n');
 if(f.method==='initialize'){
  const delay=settings.slowInitAfterFirstMs&&before.some(x=>x.method==='initialize')?settings.slowInitAfterFirstMs:0;
  setTimeout(()=>send({id:f.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}}}),delay);
 } else if(f.method==='session/new'){
  const id='ext-'+process.pid+'-'+(++counter);
  setTimeout(()=>{
   if(settings.notify){
    update(id,{sessionUpdate:'available_commands_update',availableCommands:[{name:'early',description:'early'}]});
    setTimeout(()=>update(id,{sessionUpdate:'session_info_update',title:'late-'+id}),30);
   }
   send({id:f.id,result:{sessionId:id,configOptions:options}});
  },settings.slowSessionNewMs||0);
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
  };
  // 每个会话 app 各自一个 port，同 CLI 进程共享同一个池。
  const openPort = (sessionId: string) => {
    const port = createExternalEnginePort({
      env,
      executable: process.execPath,
      processPool: pool,
      logger: log.logger,
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
  return { root, pool, log, openPort, calls };
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
    await vi.waitFor(() => expect(alive(sparePid)).toBe(false));
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
      const { pool, log, openPort, calls } = await setup([engine], {
        now: later,
        idleExemptCount: 0,
      });
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

  test("最近 3 个可恢复会话与未 prompt 的草稿不关闭，运行中的会话不关闭", async () => {
    const { pool, log, openPort } = await setup(["codex"], { now: later });
    const draft = openPort("draft");
    await draft.prepareSession(input("draft", "codex"));
    const ports = [];
    for (const id of ["s1", "s2", "s3", "s4"]) {
      const port = openPort(id);
      await port.runTurn(input(id, "codex"));
      ports.push(port);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await pool.sweepIdle();
    expect(log.named("external_engine.idle_close").map((item) => item.context.sessionId)).toEqual([
      "s1",
    ]);
    expect(draft.isSessionConnected?.("draft")).toBe(true);
    expect(ports.map((port, index) => port.isSessionConnected?.(`s${index + 1}`))).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  test("运行中（等待权限）的会话不关闭，结束后才可关闭", async () => {
    const { pool, log, openPort } = await setup(["codex"], { now: later, idleExemptCount: 0 });
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
