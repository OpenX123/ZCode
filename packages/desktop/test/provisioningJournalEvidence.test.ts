import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureProvisioningJournalBaseline,
  readProvisioningJournalSettlement,
} from "./e2e/helpers/provisioning-journal-evidence.js";

const transport = vi.hoisted(() => ({
  text: "",
  home: "/home/test-user",
  canonicalHome: "/home/test-user",
  readError: undefined as Error | undefined,
  homeError: undefined as Error | undefined,
  execError: undefined as Error | undefined,
  openError: undefined as Error | undefined,
  exitCode: 0 as number | null,
  signal: undefined as string | undefined,
  homeBytes: undefined as Buffer | undefined,
  paths: [] as string[],
  homeRequests: [] as string[],
  commands: [] as string[],
  operations: [] as string[],
  clientIds: [] as number[],
  nextClientId: 0,
  closeHome: undefined as (() => void) | undefined,
  opened: 0,
  closed: 0,
  destroyed: 0,
  pending: null as "exec-ack" | "exec-data" | "exec-close" | "open" | "home" | "read" | null,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    Client: class extends EventEmitter {
      id = ++transport.nextClientId;
      record(operation: string) {
        transport.operations.push(operation);
        transport.clientIds.push(this.id);
      }
      connect() {
        this.record("connect");
        transport.opened++;
        this.emit("ready");
      }
      exec(command: string, callback: (error: Error | undefined, value?: unknown) => void) {
        this.record("exec");
        transport.commands.push(command);
        if (transport.pending === "exec-ack") return;
        if (transport.execError) return callback(transport.execError);
        const channel = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
        transport.closeHome = () => {
          this.record("exec-close");
          channel.emit("close", transport.exitCode, transport.signal);
        };
        callback(undefined, channel);
        queueMicrotask(() => {
          channel.stderr.end("不得保存的stderr正文");
          if (transport.pending === "exec-data") return;
          channel.emit("data", transport.homeBytes ?? Buffer.from(transport.home));
          if (transport.pending !== "exec-close") transport.closeHome!();
        });
      }
      sftp(callback: (error: Error | undefined, value?: unknown) => void) {
        this.record("sftp");
        if (transport.pending === "open") return;
        if (transport.openError) return callback(transport.openError);
        callback(undefined, {
          realpath: (path: string, done: (error?: Error, home?: string) => void) => {
            this.record("realpath");
            transport.homeRequests.push(path);
            if (transport.pending === "home") return;
            done(transport.homeError, transport.canonicalHome);
          },
          readFile: (path: string, done: (error?: Error, data?: Buffer) => void) => {
            this.record("read");
            transport.paths.push(path);
            if (transport.pending === "read") return;
            done(transport.readError, Buffer.from(transport.text));
          },
        });
      }
      end() {
        this.record("end");
        transport.closed++;
      }
      destroy() {
        this.record("destroy");
        transport.destroyed++;
      }
    },
  };
});

const config = { host: "test-host", port: 22, username: "test-user", password: "test-fixture" };
const environmentKey = "this-run-environment";
let logDirectory: string;

function record(syncId: string, status = "applied") {
  return {
    syncId,
    result: { syncId, status, personalProviderCount: 1, credentialCount: 0, rolledBack: false },
  };
}

function records(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => record(`${prefix}-${index}`));
}

function journal(items: ReturnType<typeof record>[], schemaVersion = 1) {
  transport.text = JSON.stringify({ schemaVersion, records: items });
}

function mainLine(key = environmentKey, status = "applied") {
  return `[2026-11-17 01:00:00] [info] [pid:123] [main] [provider-provisioning] Environment sync completed ${JSON.stringify({ environmentKey: key, status, trigger: "personal-config", durationMs: 1 })}\n`;
}

async function mainLogs(count: number, key = environmentKey) {
  // GUI 同样读取本 run 目录的全部 .log；跨文件不能只等第一条或去掉重复事件。
  await writeFile(join(logDirectory, "a.log"), mainLine(key).repeat(Math.min(7, count)));
  await writeFile(join(logDirectory, "b.log"), mainLine(key).repeat(Math.max(0, count - 7)));
}

async function settlement(
  baseline: Awaited<ReturnType<typeof captureProvisioningJournalBaseline>>,
) {
  return readProvisioningJournalSettlement({ config, baseline, environmentKey, logDirectory });
}

beforeEach(async () => {
  transport.home = "/home/test-user";
  transport.canonicalHome = transport.home;
  transport.readError = undefined;
  transport.homeError = undefined;
  transport.execError = undefined;
  transport.openError = undefined;
  transport.exitCode = 0;
  transport.signal = undefined;
  transport.homeBytes = undefined;
  transport.paths = [];
  transport.homeRequests = [];
  transport.commands = [];
  transport.operations = [];
  transport.clientIds = [];
  transport.nextClientId = 0;
  transport.closeHome = undefined;
  transport.opened = 0;
  transport.closed = 0;
  transport.destroyed = 0;
  transport.pending = null;
  journal([]);
  logDirectory = await mkdtemp(join(tmpdir(), "provisioning-journal-evidence-"));
  await mainLogs(0);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(logDirectory, { recursive: true, force: true });
  expect(transport.closed).toBe(transport.opened);
});

describe("GUI hold 前真实 SFTP journal 与 Main parser 数值收口", () => {
  it("固定printf与标准realpath/read在同一个认证client，HOME不插入命令", async () => {
    transport.home = "/home/test user's dir";
    transport.canonicalHome = transport.home;
    await captureProvisioningJournalBaseline(config);
    expect(transport.commands).toEqual([`printf '%s' "$HOME"`]);
    expect(transport.homeRequests).toEqual([transport.home]);
    expect(transport.paths).toEqual([
      `${transport.home}/.zcode/v2/runtime/provider/provisioning.json`,
    ]);
    expect(transport.operations).toEqual([
      "connect",
      "exec",
      "exec-close",
      "sftp",
      "realpath",
      "read",
      "end",
    ]);
    expect(transport.clientIds.every((id) => id === 1)).toBe(true);
    expect(transport.opened).toBe(1);
  });

  it.each([
    ["空", ""],
    ["相对", "home/test-user"],
    ["非规范", "/home/../test-user"],
    ["过长", "/" + "x".repeat(4096)],
    ["NUL", "/home/test\0user"],
    ["换行", "/home/test\nuser"],
    ["回车", "/home/test\ruser"],
    ["DEL", "/home/test\u007fuser"],
  ])("HOME%s必须在打开SFTP前安全拒绝", async (_label, home) => {
    transport.home = home;
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow("invalid-home");
    expect(transport.operations).not.toContain("sftp");
    expect(transport.paths).toHaveLength(0);
  });

  it("HOME无效UTF8不能被替换字符静默修成路径", async () => {
    transport.homeBytes = Buffer.from([47, 104, 111, 109, 101, 47, 255]);
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow("invalid-home");
    expect(transport.paths).toHaveLength(0);
  });

  it.each([
    [1, undefined],
    [null, undefined],
    [0, "TERM"],
  ])("HOME命令code=%s/signal=%s不能被当成功", async (code, signal) => {
    transport.exitCode = code;
    transport.signal = signal;
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow("home-command-failed");
    expect(transport.paths).toHaveLength(0);
  });

  it("HOME exec ACK错误不能透传自由正文或改走SFTP猜HOME", async () => {
    transport.execError = new Error("不得保存的exec正文");
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow("home-exec-failed");
    expect(transport.operations).not.toContain("sftp");
  });

  it("标准SFTP open错误也不能按初始缺失放行", async () => {
    transport.openError = Object.assign(new Error("不得保存的open正文"), { code: 2 });
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow("sftp-open-failed");
    expect(transport.paths).toHaveLength(0);
  });

  it("realpath规范路径不等于认证HOME即拒绝，不fallback到cwd或另一个用户", async () => {
    transport.canonicalHome = "/home/other-user";
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow(
      "home-realpath-mismatch",
    );
    expect(transport.homeRequests).toEqual([transport.home]);
    expect(transport.paths).toHaveLength(0);
    expect(transport.opened).toBe(1);
  });

  it("exec已消耗的时间不会在进入SFTP后重置单60秒控制deadline", async () => {
    vi.useFakeTimers();
    transport.pending = "exec-close";
    let result: string | undefined;
    const operation = captureProvisioningJournalBaseline(config).then(
      () => {
        result = "unexpected-success";
      },
      (error: Error) => {
        result = error.message;
      },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result).toBeUndefined();
    transport.pending = "read";
    transport.closeHome!();
    await vi.advanceTimersByTimeAsync(39_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await operation;
    expect(result).toBe("Provisioning journal evidence: sftp-read-timeout");
    expect(transport.destroyed).toBe(1);
    expect(transport.opened).toBe(1);
  });

  it.each(["exec-ack", "exec-data", "exec-close", "open", "home", "read"] as const)(
    "%s pending 沿原60000ms控制预算取消并关闭连接",
    async (stage) => {
      vi.useFakeTimers();
      transport.pending = stage;
      let result: string | undefined;
      const operation = captureProvisioningJournalBaseline(config).then(
        () => {
          result = "unexpected-success";
        },
        (error: Error) => {
          result = error.message;
        },
      );
      await vi.advanceTimersByTimeAsync(59_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe("Provisioning journal evidence: sftp-read-timeout");
      await operation;
      expect(transport.destroyed).toBe(1);
      expect(transport.closed).toBe(1);
    },
  );

  it("旧61+新14只与本轮14条完整 Main applied 对账，保留历史和精确 HOME", async () => {
    const old = records("old", 61);
    journal(old);
    const baseline = await captureProvisioningJournalBaseline(config);
    journal([...old, ...records("new", 14)]);
    await mainLogs(14);
    const result = await settlement(baseline);
    expect(result).toMatchObject({ environmentKey, settled: true, mainAppliedCount: 14 });
    expect(result.baselineAppliedSyncIds).toEqual(old.map((item) => item.syncId));
    expect(result.appliedSyncIds).toHaveLength(75);
    expect(result.newAppliedSyncIds).toEqual(records("new", 14).map((item) => item.syncId));
    expect(transport.homeRequests).toEqual(["/home/test-user", "/home/test-user"]);
    expect(transport.paths).toEqual(
      Array(2).fill("/home/test-user/.zcode/v2/runtime/provider/provisioning.json"),
    );
  });

  it.each([
    [14, 13, "14笔新提交仅13回应"],
    [15, 14, "多一笔未回应"],
    [14, 15, "Main重复计数"],
    [0, 0, "没有任何本轮提交"],
  ])("%s个新ID/%s条Main：%s不得收口", async (commits, responses) => {
    journal(records("old", 61));
    const baseline = await captureProvisioningJournalBaseline(config);
    journal([...records("old", 61), ...records("new", commits)]);
    await mainLogs(responses);
    expect((await settlement(baseline)).settled).toBe(false);
  });

  it("旧 already-applied 重放不制造新 commit，也不能充当新 applied 回应", async () => {
    journal(records("old", 1));
    const baseline = await captureProvisioningJournalBaseline(config);
    journal([...records("old", 1), ...records("new", 1)]);
    await writeFile(
      join(logDirectory, "a.log"),
      mainLine() + mainLine(environmentKey, "already-applied"),
    );
    expect(await settlement(baseline)).toMatchObject({
      mainAppliedCount: 1,
      newAppliedSyncIds: ["new-0"],
      settled: true,
    });
  });

  it("baseline applied ID 丢失即失败，不能让新总数碰巧匹配放行", async () => {
    journal(records("old", 1));
    const baseline = await captureProvisioningJournalBaseline(config);
    journal(records("new", 14));
    await mainLogs(14);
    await expect(settlement(baseline)).rejects.toThrow("baseline-not-retained");
  });

  it("HOME 改变即失败，不把另一用户 journal 当当前目标", async () => {
    const baseline = await captureProvisioningJournalBaseline(config);
    transport.home = "/home/other-user";
    transport.canonicalHome = transport.home;
    journal(records("new", 1));
    await mainLogs(1);
    await expect(settlement(baseline)).rejects.toThrow("home-changed");
  });

  it("完整 Main 事件只属于其它 Environment 时不能收口", async () => {
    const baseline = await captureProvisioningJournalBaseline(config);
    journal(records("new", 14));
    await mainLogs(14, "other-environment");
    expect(await settlement(baseline)).toMatchObject({ mainAppliedCount: 0, settled: false });
  });

  it("其它 Environment 的 applied 不能混入本轮期望环境计数", async () => {
    const baseline = await captureProvisioningJournalBaseline(config);
    journal(records("new", 14));
    await mainLogs(14);
    await writeFile(join(logDirectory, "c.log"), mainLine("other-environment").repeat(3));
    expect(await settlement(baseline)).toMatchObject({ mainAppliedCount: 14, settled: true });
  });

  it.each([
    ["重复 applied ID", () => journal([record("duplicate"), record("duplicate")])],
    ["跨状态重复 ID", () => journal([record("duplicate"), record("duplicate", "failed")])],
    ["空 ID", () => journal([record("")])],
    ["纯空白 ID", () => journal([record(" ")])],
    ["错误 schemaVersion", () => journal(records("new", 1), 2)],
    [
      "result schema 错误",
      () => {
        transport.text = JSON.stringify({
          schemaVersion: 1,
          records: [{ syncId: "id", result: { syncId: "id", status: "applied" } }],
        });
      },
    ],
    [
      "record/result ID 不一致",
      () => {
        const item = record("id");
        item.result.syncId = "other";
        journal([item]);
      },
    ],
    [
      "坏 JSON",
      () => {
        transport.text = "{broken";
      },
    ],
  ])("%s必须经共享schema验证并失败，不保存错误正文", async (_name, arrange) => {
    arrange();
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow("invalid-journal");
  });

  it.each([2, "ENOENT"])("初次精确 SFTP %s 可捕获空基线，随后真实首装提交收口", async (code) => {
    transport.readError = Object.assign(new Error("不得输出的读取正文"), { code });
    const baseline = await captureProvisioningJournalBaseline(config);
    expect(baseline).toMatchObject({ appliedSyncIds: [], initialRead: "missing" });
    transport.readError = undefined;
    journal(records("new", 1));
    await mainLogs(1);
    expect((await settlement(baseline)).settled).toBe(true);
  });

  it.each(["EACCES", "EIO", 3, 4, "2", undefined])(
    "初次其它错误 %s 不得伪装空 journal",
    async (code) => {
      transport.readError = Object.assign(new Error("不得输出的读取正文"), { code });
      await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow(
        "journal-read-failed",
      );
    },
  );

  it("HOME 解析的缺失不是文件缺失，不能按初始空 journal 放行", async () => {
    transport.homeError = Object.assign(new Error("不得输出的 HOME 正文"), { code: 2 });
    await expect(captureProvisioningJournalBaseline(config)).rejects.toThrow(
      "sftp-realpath-failed",
    );
    expect(transport.paths).toHaveLength(0);
  });

  it("后续文件消失不享有初始缺失豁免", async () => {
    const baseline = await captureProvisioningJournalBaseline(config);
    transport.readError = Object.assign(new Error("不得输出的读取正文"), { code: 2 });
    await expect(settlement(baseline)).rejects.toThrow("journal-missing");
  });
});
