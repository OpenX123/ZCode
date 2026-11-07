import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficialPluginFileStat } from "../../src/app/official-plugin-digest/index.js";

const DIGEST_STORE_FILE = "official-plugin-digests.json";
const DEFINITION = { name: "fixture-plugin", version: "1.0.0" };

/** 每次重新加载模块等价于一个新的 CLI 进程：进程内记忆清空，只剩持久化文件。 */
async function loadFreshModule() {
  vi.resetModules();
  return await import("../../src/app/official-plugin-digest/index.js");
}

function fileStats(rootPath: string, mtimeMs = 1_000): OfficialPluginFileStat[] {
  return ["a.js", "b/c.json"].map((path, index) => ({
    mode: 0o644,
    mtimeMs: mtimeMs + index,
    path,
    size: 10 + index,
    sourcePath: join(rootPath, path),
  }));
}

function hashOf(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  return logger as Logger & { warn: ReturnType<typeof vi.fn> };
}

describe("内置插件摘要缓存", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  async function createRoots() {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-digest-"));
    roots.push(root);
    return { pluginRoot: join(root, "source"), storageRoot: join(root, "storage") };
  }

  it("同一进程只哈希一次，之后不再枚举也不读内容", async () => {
    const { pluginRoot, storageRoot } = await createRoots();
    const cache = await loadFreshModule();
    const listFiles = vi.fn(() => fileStats(pluginRoot));
    const hashFile = vi.fn((file: OfficialPluginFileStat) => hashOf(file.path));
    const input = {
      appVersion: "1.1.0",
      definition: DEFINITION,
      hashFile,
      listFiles,
      rootPath: pluginRoot,
      storageRoot,
    };

    const first = cache.resolveOfficialPluginFileDigests(input);
    const second = cache.resolveOfficialPluginFileDigests(input);

    expect(first.source).toBe("hashed");
    expect(second.source).toBe("memory");
    expect(second.files).toEqual(first.files);
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(hashFile).toHaveBeenCalledTimes(2);
    expect(existsSync(join(storageRoot, DIGEST_STORE_FILE))).toBe(true);
  });

  it("新进程在文件统计签名一致时复用持久化摘要，不读取文件内容", async () => {
    const { pluginRoot, storageRoot } = await createRoots();
    const writer = await loadFreshModule();
    const hashed = writer.resolveOfficialPluginFileDigests({
      appVersion: "1.1.0",
      definition: DEFINITION,
      hashFile: (file) => hashOf(file.path),
      listFiles: () => fileStats(pluginRoot),
      rootPath: pluginRoot,
      storageRoot,
    });

    const reader = await loadFreshModule();
    const hashFile = vi.fn(() => "should-not-be-called");
    const reused = reader.resolveOfficialPluginFileDigests({
      appVersion: "1.1.0",
      definition: DEFINITION,
      hashFile,
      listFiles: () => fileStats(pluginRoot),
      rootPath: pluginRoot,
      storageRoot,
    });

    expect(reused.source).toBe("persisted");
    expect(hashFile).not.toHaveBeenCalled();
    expect(reused.files).toEqual(hashed.files);
  });

  it.each([
    ["文件 mtime 变化", { mtimeMs: 2_000 }],
    ["应用版本变化", { appVersion: "1.1.1" }],
    ["插件版本变化", { version: "1.0.1" }],
  ])("%s时重新哈希并覆盖持久化项", async (_label, change) => {
    const { pluginRoot, storageRoot } = await createRoots();
    const writer = await loadFreshModule();
    writer.resolveOfficialPluginFileDigests({
      appVersion: "1.1.0",
      definition: DEFINITION,
      hashFile: (file) => hashOf(file.path),
      listFiles: () => fileStats(pluginRoot),
      rootPath: pluginRoot,
      storageRoot,
    });

    const reader = await loadFreshModule();
    const hashFile = vi.fn((file: OfficialPluginFileStat) => hashOf(`${file.path}:new`));
    const result = reader.resolveOfficialPluginFileDigests({
      appVersion: "appVersion" in change ? change.appVersion : "1.1.0",
      definition: { ...DEFINITION, ...("version" in change ? { version: change.version } : {}) },
      hashFile,
      listFiles: () => fileStats(pluginRoot, "mtimeMs" in change ? change.mtimeMs : 1_000),
      rootPath: pluginRoot,
      storageRoot,
    });

    expect(result.source).toBe("hashed");
    expect(hashFile).toHaveBeenCalledTimes(2);
    expect(result.files.map((file) => file.sha256)).toEqual([
      hashOf("a.js:new"),
      hashOf("b/c.json:new"),
    ]);
  });

  it("损坏的持久化文件按未命中处理并被重写为有效内容", async () => {
    const { pluginRoot, storageRoot } = await createRoots();
    await mkdir(storageRoot, { recursive: true });
    await writeFile(join(storageRoot, DIGEST_STORE_FILE), "{not json");
    const cache = await loadFreshModule();

    const result = cache.resolveOfficialPluginFileDigests({
      definition: DEFINITION,
      hashFile: (file) => hashOf(file.path),
      listFiles: () => fileStats(pluginRoot),
      rootPath: pluginRoot,
      storageRoot,
    });

    expect(result.source).toBe("hashed");
    const store = JSON.parse(await readFile(join(storageRoot, DIGEST_STORE_FILE), "utf8")) as {
      entries: Record<string, { appVersion: string; files: unknown[] }>;
      version: number;
    };
    expect(store.version).toBe(1);
    expect(Object.values(store.entries)).toEqual([
      expect.objectContaining({ appVersion: "unknown", files: expect.any(Array) }),
    ]);
  });

  it("持久化写入失败只告警，仍返回本次计算的摘要", async () => {
    const { pluginRoot, storageRoot } = await createRoots();
    // 存储根目录被同名文件占用，mkdir/rename 都会失败。
    await mkdir(join(storageRoot, ".."), { recursive: true });
    await writeFile(storageRoot, "occupied");
    expect((await stat(storageRoot)).isFile()).toBe(true);
    const cache = await loadFreshModule();
    const logger = createLogger();

    const result = cache.resolveOfficialPluginFileDigests({
      definition: DEFINITION,
      hashFile: (file) => hashOf(file.path),
      listFiles: () => fileStats(pluginRoot),
      logger,
      rootPath: pluginRoot,
      storageRoot,
    });

    expect(result.source).toBe("hashed");
    expect(result.files).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin digest cache write failed",
      expect.objectContaining({ event: "bootstrap.official_plugin_digest.write_failed" }),
    );
  });
});
