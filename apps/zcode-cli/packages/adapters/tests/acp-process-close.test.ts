import { afterEach, describe, expect, test, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import * as processes from "node:child_process";
import { spawnAcpProcess, closeAcpProcessAndWait } from "../src/exec/acp-process.js";
import { createExternalEngineProcessPool } from "../src/external-engine/process-pool.js";
import { AcpConnection } from "../src/external-engine/connection.js";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const controls = vi.hoisted(() => ({ taskkillFailure: false as false | "error" | "nonzero" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (controls.taskkillFailure && String(args[0]).toLowerCase() === "taskkill") {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() =>
          controls.taskkillFailure === "error"
            ? child.emit("error", new Error("fixture taskkill unavailable"))
            : child.emit("close", 1),
        );
        return child;
      }
      return actual.spawn(...args);
    },
  };
});

const children: processes.ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  controls.taskkillFailure = false;
  for (const child of children.splice(0)) {
    if (process.platform === "win32") {
      const killer = processes.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await once(killer, "exit");
    } else {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
  }
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function helper(script: string) {
  const child = spawnAcpProcess(process.execPath, ["-e", script], tmpdir(), process.env);
  children.push(child);
  const [output] = await once(child.stdout, "data");
  return { child, pid: Number(String(output).trim()) };
}

describe("ACP 严格进程树退出确认", () => {
  test.skipIf(process.platform !== "win32")(
    "真实关闭失败时 pool 保留许可；确认旧树退出后才能 ACK 和重新授权",
    async () => {
      const { child } = await helper(
        "process.stdin.resume();setInterval(()=>{},1000);console.log(process.pid)",
      );
      let lease: string | undefined;
      const pool = createExternalEngineProcessPool({
        budget: {
          acquire: async (id) => {
            if (lease) return false;
            lease = id;
            return true;
          },
          release: async (id) => {
            if (lease === id) lease = undefined;
          },
        },
      });
      const connection = new AcpConnection(child);
      // 测试只替代无关握手，close 是真实 AcpConnection→exec→OS。
      vi.spyOn(connection, "prebuild").mockResolvedValue(undefined);
      pool.refillSpare(
        { engine: "codex", connectionProfileId: "inherit", cwd: tmpdir() },
        async () => connection,
      );
      await vi.waitFor(() => expect(lease).toBeDefined());
      await Promise.resolve();
      controls.taskkillFailure = "error";
      try {
        await expect(pool.revokeSpare(lease!)).rejects.toThrow();
        expect(lease).toBeDefined();
        expect(alive(child.pid!)).toBe(true);
        controls.taskkillFailure = false;
        await pool.revokeSpare(lease!);
        expect(lease).toBeUndefined();
        expect(alive(child.pid!)).toBe(false);
      } finally {
        controls.taskkillFailure = false;
        await pool.close();
      }
    },
  );
  test.skipIf(process.platform !== "win32")("真实 Windows 根和子代退出后才完成", async () => {
    const { child, pid } = await helper(
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000);console.log(process.pid)'],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',b=>process.stdout.write(b));setInterval(()=>{},1000);",
    );
    expect(alive(pid)).toBe(true);
    await closeAcpProcessAndWait(child);
    expect(alive(child.pid!)).toBe(false);
    expect(alive(pid)).toBe(false);
  });
  test.skipIf(process.platform !== "win32").each(["error", "nonzero"] as const)(
    "taskkill %s 且旧树仍活时拒绝成功",
    async (failure) => {
      const { child } = await helper(
        "process.stdin.resume();setInterval(()=>{},1000);console.log(process.pid)",
      );
      controls.taskkillFailure = failure;
      // 先以旧helper运行这条回归，旧实现只kill根并resolve，不能作为Host许可释放依据。
      await expect(closeAcpProcessAndWait(child)).rejects.toThrow();
      expect(alive(child.pid!)).toBe(true);
    },
  );
  test.skipIf(process.platform !== "win32")(
    "备用内部协议失败与显式 close 共享严格关闭，失败可重试",
    async () => {
      const { child } = await helper(
        "process.stdin.on('data',()=>console.log('{bad'));setInterval(()=>{},1000);console.log(process.pid)",
      );
      const connection = new AcpConnection(child, undefined, true);
      const close = vi.spyOn(connection, "close");
      controls.taskkillFailure = "error";
      child.stdin.write("break\n");
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      const internal = close.mock.results[0]!.value as Promise<void>;
      expect(connection.close(true)).toBe(internal);
      await expect(internal).rejects.toThrow();
      expect(alive(child.pid!)).toBe(true);
      controls.taskkillFailure = false;
      const retried = connection.close(true);
      await retried;
      expect(alive(child.pid!)).toBe(false);
      expect(connection.close(true)).toBe(retried);
    },
  );
  test.skipIf(process.platform === "win32")(
    "忽略 SIGTERM 的真实组长必须结束后才 resolve",
    async () => {
      const { child } = await helper(
        "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log(process.pid)",
      );
      await closeAcpProcessAndWait(child);
      expect(alive(child.pid!)).toBe(false);
    },
  );
  test.skipIf(process.platform === "win32")("组长先退出而同组子代仍活时等待整组结束", async () => {
    const { child, pid } = await helper(
      "const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log(process.pid)\"],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',b=>{process.stdout.write(b);process.exit(0)});",
    );
    await closeAcpProcessAndWait(child);
    // POSIX 已终止但尚待 init 回收的僵尸不再执行；kill(pid,0) 不能区分它与活进程。
    const status = await new Promise<string>((resolve) =>
      processes.execFile("ps", ["-o", "stat=", "-p", String(pid)], (_error, stdout) =>
        resolve(stdout.trim()),
      ),
    );
    expect(status === "" || status.startsWith("Z")).toBe(true);
  });
});
