// 外部引擎进程池：预热备用进程与闲置连接关闭（docs/desktop/external-agent-engines-spec.md P04–P07）。
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
const fixture = (settings: { slowInitAfterFirstMs?: number }) => String.raw`
const fs=require('node:fs'), path=require('node:path'), readline=require('node:readline');
const settings=${JSON.stringify(settings)}, log=path.join(process.env.HOME,'calls.jsonl');
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
let counter=0, prompt;
const options=[{id:'mode',name:'Mode',currentValue:'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(!f.method){ if(f.id===900) send({id:prompt.id,result:{stopReason:'end_turn'}}); return; }
 const before=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 fs.appendFileSync(log,JSON.stringify({pid:process.pid,method:f.method,sessionId:f.params?.sessionId,value:f.params?.value})+'\n');
 if(f.method==='initialize'){
  const delay=settings.slowInitAfterFirstMs&&before.some(x=>x.method==='initialize')?settings.slowInitAfterFirstMs:0;
  setTimeout(()=>send({id:f.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}}}),delay);
 } else if(f.method==='session/new') send({id:f.id,result:{sessionId:'ext-'+process.pid+'-'+(++counter),configOptions:options}});
 else if(f.method==='session/resume') send({id:f.id,result:{sessionId:f.params.sessionId,configOptions:options}});
 else if(f.method==='session/set_config_option'){options[0].currentValue=f.params.value; send({id:f.id,result:{configOptions:options}});}
 else if(f.method==='session/prompt'){
  if(f.params.prompt[0].text==='hold'){prompt=f; send({id:900,method:'session/request_permission',params:{sessionId:f.params.sessionId,toolCall:{toolCallId:'t'},options:[{optionId:'deny',kind:'reject_once',name:'Deny'}]}}); return;}
  send({id:f.id,result:{stopReason:'end_turn'}});
 }
});`;

interface Call {
  pid: number;
  method: string;
  sessionId?: string;
  value?: string;
}

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
  settings: { slowInitAfterFirstMs?: number } = {},
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

describe("预热备用进程", () => {
  test.each(["claude-code", "codex"] as const)(
    "%s 同配置第二个新会话领用已 initialize 的备用进程并在后台补位，至多一个",
    async (engine) => {
      const { log, openPort, calls } = await setup([engine]);
      await openPort("s1").prepareSession(input("s1", engine));
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
      const initialized = (await calls()).filter((call) => call.method === "initialize");
      expect(initialized).toHaveLength(2);
      const sparePid = initialized[1]!.pid;
      expect(log.named("external_engine.spare.miss")[0]?.context.reason).toBe("none");

      await openPort("s2").prepareSession(input("s2", engine));
      const afterClaim = await calls();
      // 领用后 session/new 发在备用进程上，且没有在它上面重复 initialize。
      expect(
        afterClaim.find((call) => call.method === "session/new" && call.pid === sparePid),
      ).toBeTruthy();
      expect(
        afterClaim.filter((call) => call.method === "initialize" && call.pid === sparePid),
      ).toHaveLength(1);
      expect(log.named("external_engine.spare.claimed")).toHaveLength(1);
      expect(log.named("external_engine.handshake.completed").at(-1)?.context).toMatchObject({
        spare: "hit",
        method: "session/new",
      });
      // 领用后补位一个新的备用进程，不会多于一个。
      await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await calls()).filter((call) => call.method === "initialize")).toHaveLength(3);
      expect((await calls()).some((call) => call.method === "session/prompt")).toBe(false);
    },
  );

  test("备用进程不跨连接配置复用", async () => {
    const { log, openPort, calls } = await setup(["claude-code"]);
    await openPort("s1").prepareSession(
      input("s1", "claude-code", { connectionProfileId: "inherit" }),
    );
    await vi.waitFor(() => expect(log.named("external_engine.spare.ready")).toHaveLength(1));
    const sparePid = (await calls()).filter((call) => call.method === "initialize")[1]!.pid;
    await openPort("s2").prepareSession(
      input("s2", "claude-code", { connectionProfileId: "official" }),
    );
    expect(log.named("external_engine.spare.claimed")).toHaveLength(0);
    expect(log.named("external_engine.spare.miss").at(-1)?.context).toMatchObject({
      connectionProfileId: "official",
      reason: "none",
    });
    expect(
      (await calls()).some((call) => call.method === "session/new" && call.pid === sparePid),
    ).toBe(false);
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
