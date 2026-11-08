import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
const resolver = vi.hoisted(() => vi.fn());
vi.mock("@zcode/services/storage-startup", () => ({ resolveDefaultZCodeAgentCommand: resolver }));
import { prepareSessionStorage } from "../src/host/database-startup/storagePreparationProcesses.js";

// docs/desktop/host-idle-resources-1.1-spec.md §5：只给存储准备 Worker 启用 Node 编译缓存，并回报分段耗时。

it("Worker 环境带编译缓存目录，Host 进程环境不变，并回报 bundle 加载等分段耗时", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-compile-cache-"));
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    lines.once('line', () => {
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
    const cache = process.env.NODE_COMPILE_CACHE || 'missing';
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path: cache + '/session.sqlite'}})+'\\n');
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const cacheDir = join(dir, "cache", "node-compile-cache");
  const observed: string[] = [];
  const hostEnvBefore = process.env.NODE_COMPILE_CACHE;
  try {
    const timing = await prepareSessionStorage({
      cwd: dir,
      signal: new AbortController().signal,
      report: () => {},
      observePath: async (path) => {
        observed.push(path);
      },
      compileCacheDir: cacheDir,
    });
    expect(observed).toEqual([`${cacheDir}/session.sqlite`]);
    expect(process.env.NODE_COMPILE_CACHE).toBe(hostEnvBefore);
    expect(timing).toMatchObject({
      workerLoadMs: expect.any(Number),
      observeMs: expect.any(Number),
      prepareMs: expect.any(Number),
      exitMs: expect.any(Number),
      reuse: false,
      compileCache: "enabled",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
