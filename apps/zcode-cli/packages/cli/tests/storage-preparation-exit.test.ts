// `--prepare-storage` 完成即退出（docs/design/v2/zcode-protocol-agent-server.md「存储准备完成即退出」）：
// Host 实测会话库准备 Worker 约 1.9s 中约 1.0s 在等一次性 CLI 退出 watchdog（1s）。存储准备返回后
// 先等 stdout/stderr 已排队写完成，再立即按退出码退出；其它一次性命令仍用 watchdog。
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { cliOneShotExitPlan, exitCliAfterOneShot } from "../src/shutdown.js";

test("存储准备立即退出，其它一次性命令保留 watchdog，plugin-host 成功不安排退出", () => {
  assert.equal(
    cliOneShotExitPlan({ argv: ["app-server", "--stdio", "--prepare-storage"], exitCode: 0 }),
    "immediate",
  );
  assert.equal(
    cliOneShotExitPlan({ argv: ["app-server", "--stdio", "--prepare-storage"], exitCode: 1 }),
    "immediate",
  );
  assert.equal(cliOneShotExitPlan({ argv: ["doctor"], exitCode: 0 }), "watchdog");
  assert.equal(
    cliOneShotExitPlan({ argv: ["__zcode-plugin-host"], exitCode: 0, pluginHost: true }),
    "none",
  );
  assert.equal(
    cliOneShotExitPlan({ argv: ["__zcode-plugin-host"], exitCode: 2, pluginHost: true }),
    "watchdog",
  );
});

test("立即退出先等已排队的输出写回调，再以原退出码退出，不等待 1s", async () => {
  const pending: Array<() => void> = [];
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      pending.push(callback);
    },
  });
  stream.write("startup/storagePrepared\n");
  const exits: number[] = [];
  const startedAt = performance.now();
  const exiting = exitCliAfterOneShot({
    exitCode: 0,
    streams: [stream],
    exitProcess: (code) => exits.push(code),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [], "队列中的结果帧写完前不能退出");
  while (pending.length > 0) pending.shift()!();
  await exiting;
  assert.deepEqual(exits, [0]);
  assert.ok(performance.now() - startedAt < 500, "不应等待 watchdog 期限");
});

test("已结束或已销毁的输出流不阻塞退出，失败退出码原样保留", async () => {
  const ended = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  ended.end();
  const destroyed = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  destroyed.destroy();
  const exits: number[] = [];
  await exitCliAfterOneShot({
    exitCode: 3,
    streams: [ended, destroyed],
    exitProcess: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [3]);
});
