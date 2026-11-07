import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveZCodePlugins } = vi.hoisted(() => ({
  resolveZCodePlugins: vi.fn(() => ({
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  })),
}));

vi.mock("../src/plugins.js", () => ({ resolveZCodePlugins }));

import { listZCodeCustomCommands } from "../src/custom-commands.js";

describe("自定义命令发现复用插件解析", () => {
  const roots: string[] = [];
  afterEach(async () => {
    resolveZCodePlugins.mockClear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("插件修订不变时复用命令根目录，安装与启停后重新解析", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-custom-command-plugin-memo-"));
    roots.push(root);
    const storageDir = join(root, "storage");
    const workingDirectory = join(root, "workspace");
    const projectConfigPath = join(root, "project-config.json");
    await mkdir(workingDirectory, { recursive: true });
    await writeFile(projectConfigPath, JSON.stringify({}));
    const options = {
      env: { ZCODE_STORAGE_DIR: storageDir },
      projectConfigPath,
      skipUserConfig: true,
      workingDirectory,
    };

    await listZCodeCustomCommands(options);
    await listZCodeCustomCommands(options);
    expect(resolveZCodePlugins).toHaveBeenCalledTimes(1);

    // 安装：插件存储记录变化。
    const pluginStorageRoot = join(storageDir, "cli", "plugins");
    await mkdir(pluginStorageRoot, { recursive: true });
    await writeFile(
      join(pluginStorageRoot, "installed_plugins.json"),
      JSON.stringify({ plugins: { "demo@market": [{ version: "1.0.0" }] } }),
    );
    await listZCodeCustomCommands(options);
    expect(resolveZCodePlugins).toHaveBeenCalledTimes(2);

    // 启停：生效配置的插件段变化。
    await writeFile(
      projectConfigPath,
      JSON.stringify({ plugins: { enabledPlugins: { "demo@market": false } } }),
    );
    await listZCodeCustomCommands(options);
    expect(resolveZCodePlugins).toHaveBeenCalledTimes(3);

    // 没有变化时继续命中。
    await listZCodeCustomCommands(options);
    expect(resolveZCodePlugins).toHaveBeenCalledTimes(3);
  });
});
