import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";

// 回归（1.1.0 Windows 生产日志 2026-11-07 12:39）：窗口重载时 6 个工作区 CLI 并发建会话，
// 一个进程释放 visualize 的 seed lock 时 rmSync 删目录遇 EPERM，留下无 owner.json 的空锁目录；
// 其余进程每次建 app 都进锁检查缓存，遇到"无主且不足 60s"的锁不接管，Atomics.wait 同步
// 阻塞事件循环满 15s，Host 侧 sendConversationCommandV4 / 握手因此卡 15s、31s、46s。
// 缓存已是当前版本时，建 app 不应等待任何 seed lock。
const FAST_PATH_BUDGET_MS = 2_000;
const TEST_TIMEOUT_MS = 30_000;

describe("official plugin seeding with a current cache", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it(
    "does not wait on an ownerless leftover seed lock",
    async () => {
      const storageRoot = await seededStorageRoot(cleanups);
      const lockRoot = `${cacheRoot(storageRoot, "visualize")}.seed-lock`;
      // 与生产现场一致：锁目录存在、刚刚创建、内部没有 owner.json。
      await mkdir(lockRoot, { recursive: true });
      const logger = createLogger();

      const startedAt = performance.now();
      resolveOfficialPluginRoots({ logger, storageRoot });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(FAST_PATH_BUDGET_MS);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "Official plugin cache operation degraded",
        expect.anything(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not wait on a seed lock held by a live process",
    async () => {
      const storageRoot = await seededStorageRoot(cleanups);
      const lockRoot = `${cacheRoot(storageRoot, "visualize")}.seed-lock`;
      await mkdir(lockRoot, { recursive: true });
      await writeFile(
        join(lockRoot, "owner.json"),
        JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
      );
      const logger = createLogger();

      const startedAt = performance.now();
      resolveOfficialPluginRoots({ logger, storageRoot });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(FAST_PATH_BUDGET_MS);
      // 锁属于另一个存活进程，快速路径不能删除或接管它。
      expect(existsSync(join(lockRoot, "owner.json"))).toBe(true);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "Official plugin cache operation degraded",
        expect.anything(),
      );
    },
    TEST_TIMEOUT_MS,
  );
});

async function seededStorageRoot(cleanups: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-seed-fast-path-"));
  cleanups.push(root);
  const storageRoot = join(root, "plugins");
  // 首次 seed 写入当前版本缓存，等价于用户机器上已有的同版本缓存。
  resolveOfficialPluginRoots({ storageRoot });
  return storageRoot;
}

function cacheRoot(storageRoot: string, name: string): string {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name);
  if (!definition) throw new Error(`official plugin definition is missing: ${name}`);
  return join(storageRoot, "cache", "zcode-plugins-official", definition.name, definition.version);
}

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}
