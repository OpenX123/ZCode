import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const DIGEST_RESOLVED_MESSAGE = "Official plugin digests resolved";
const SKILL_CREATOR_CACHE = join("cache", "zcode-plugins-official", "skill-creator", "0.1.0");

async function writeTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function createLogger(): Logger & { info: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  return logger as Logger & { info: ReturnType<typeof vi.fn> };
}

/** 重新加载模块等价于新 CLI 进程：进程内摘要记忆清空，只能复用持久化摘要。 */
async function loadFreshBundledPlugins() {
  vi.resetModules();
  return await import("../src/app/bundled-plugins.js");
}

function digestLog(logger: { info: ReturnType<typeof vi.fn> }) {
  return logger.info.mock.calls.find(([message]) => message === DIGEST_RESOLVED_MESSAGE)?.[1] as
    | Record<string, unknown>
    | undefined;
}

describe("内置插件 seed 的摘要缓存", () => {
  const originalEntrypoint = process.argv[1];
  const roots: string[] = [];

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("同进程重复建 app 不再哈希，新进程按统计签名复用持久化摘要且 seed 结果一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-seed-digest-"));
    roots.push(root);
    const entryRoot = join(root, "resources", "glm");
    const storageRoot = join(root, "plugins");
    const pluginRoot = join(entryRoot, "packages", "skill-creator-plugin");
    await writeTestFile(join(entryRoot, "zcode.cjs"), "");
    await writeTestFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "skill-creator", skills: "skills", version: "0.1.0" }),
    );
    await writeTestFile(join(pluginRoot, "skills", "skill-creator", "SKILL.md"), "# skill");
    process.argv[1] = join(entryRoot, "zcode.cjs");
    const env = { ZCODE_APP_VERSION: "9.9.9-digest-test" };

    const firstProcess = await loadFreshBundledPlugins();
    const firstLogger = createLogger();
    firstProcess.resolveOfficialPluginRoots({ env, logger: firstLogger, storageRoot });
    const firstLog = digestLog(firstLogger);
    expect(firstLog).toMatchObject({
      event: "bootstrap.official_plugin_digest.resolved",
      memoryCount: 0,
      source: "hashed",
    });
    expect(Number(firstLog?.hashedCount)).toBeGreaterThan(0);
    const markerPath = join(storageRoot, SKILL_CREATOR_CACHE, ".zcode-plugin-seed.json");
    const firstMarker = await readFile(markerPath, "utf8");
    expect(existsSync(join(storageRoot, "official-plugin-digests.json"))).toBe(true);

    // 同一进程第二次建 app：全部命中进程内记忆，不再出现摘要解析日志。
    const secondLogger = createLogger();
    firstProcess.resolveOfficialPluginRoots({ env, logger: secondLogger, storageRoot });
    expect(digestLog(secondLogger)).toBeUndefined();

    // 新进程：文件统计签名未变，复用持久化摘要；seed marker 的 hash 与首次完全一致。
    const secondProcess = await loadFreshBundledPlugins();
    const thirdLogger = createLogger();
    secondProcess.resolveOfficialPluginRoots({ env, logger: thirdLogger, storageRoot });
    expect(digestLog(thirdLogger)).toMatchObject({
      hashedCount: 0,
      memoryCount: 0,
      persistedCount: firstLog?.pluginCount,
      source: "persisted",
    });
    expect(await readFile(markerPath, "utf8")).toBe(firstMarker);

    // 源文件内容变化（大小随之变化）后签名不一致，新进程重新哈希并重新 seed。
    await writeTestFile(join(pluginRoot, "skills", "skill-creator", "SKILL.md"), "# skill v2");
    const thirdProcess = await loadFreshBundledPlugins();
    const fourthLogger = createLogger();
    thirdProcess.resolveOfficialPluginRoots({ env, logger: fourthLogger, storageRoot });
    expect(digestLog(fourthLogger)).toMatchObject({ hashedCount: 1, source: "hashed" });
    expect(await readFile(markerPath, "utf8")).not.toBe(firstMarker);
    expect(
      await readFile(join(storageRoot, SKILL_CREATOR_CACHE, "skills", "skill-creator", "SKILL.md"), "utf8"),
    ).toBe("# skill v2");
  }, 60_000);
});
