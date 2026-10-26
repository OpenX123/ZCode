import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageAgentBundle } from "../scripts/stage-agent-bundle.mjs";
import {
  stageKoffiIntoBundledAgents,
  verifyStagedKoffi,
} from "../scripts/koffi-package-assets.mjs";

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("../../../scripts/spawn-command.mjs", () => ({ runCommand }));

const roots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "zcode-agent-assets-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  runCommand.mockReset();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("桌面 Agent 资源闭包", () => {
  it("轻量发行使用同轮清单而不重建远程资源，仍准备本地 Agent", async () => {
    vi.stubEnv("ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY", "1");

    await import("../scripts/prepare-runtime-assets.mjs");

    const commands = runCommand.mock.calls.map((call) => call[1]);
    expect(commands).toContainEqual(["scripts/github-release-assets.mjs", "verify-descriptor"]);
    expect(commands).toContainEqual(["prepare:agent-bundle"]);
    expect(commands).not.toContainEqual(["prepare:remote-assets"]);
    expect(commands[0]).toEqual(["scripts/github-release-assets.mjs", "verify-descriptor"]);
  });

  it("发行清单校验失败时不能继续准备本地 Agent", async () => {
    vi.stubEnv("ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY", "1");
    runCommand.mockImplementation(() => {
      throw new Error("invalid release descriptor");
    });

    await expect(import("../scripts/prepare-runtime-assets.mjs")).rejects.toThrow(
      "invalid release descriptor",
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("Source Server 重建清空暂存后，最后准备的桌面插件仍完整", async () => {
    const root = temporaryRoot();
    const cliDist = join(root, "apps/zcode-cli/packages/cli/dist");
    const glmDir = join(root, "packages/desktop/bundled-agents/darwin-arm64/glm");
    const pluginManifest = join(glmDir, "packages/zcode-cua-plugin/.zcode-plugin/plugin.json");
    mkdirSync(cliDist, { recursive: true });
    writeFileSync(join(cliDist, "zcode.cjs"), "module.exports = {};");
    runCommand.mockImplementation((_command: string, args: string[]) => {
      if (!["prepare:remote-assets", "prepare:agent-bundle"].includes(args[0]!)) return;
      // 真实复用清理暂存实现，模拟两条构建入口共同写同一个平台目录。
      stageAgentBundle({ repoRoot: root, platformKey: "darwin-arm64", log: () => {} });
      if (args[0] === "prepare:agent-bundle") {
        mkdirSync(join(pluginManifest, ".."), { recursive: true });
        writeFileSync(pluginManifest, "{}");
      }
    });

    await import("../scripts/prepare-runtime-assets.mjs");

    expect(existsSync(pluginManifest)).toBe(true);
    expect(existsSync(join(glmDir, "zcode.cjs"))).toBe(true);
  });

  it("macOS/Linux 不要求 Windows MCP 的 Koffi 运行时", () => {
    const root = temporaryRoot();
    for (const os of ["darwin", "linux"]) {
      const targetPlatform = { os, arch: "arm64" };
      expect(
        stageKoffiIntoBundledAgents({ koffiPackageRoot: root, glmDir: root, targetPlatform }),
      ).toBeUndefined();
      expect(verifyStagedKoffi({ resourcesDir: root, targetPlatform })).toEqual([]);
    }
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("Windows Koffi 只暂存目标平台，Agent 从 glm 根目录解析并校验缺失依赖", () => {
    const root = temporaryRoot();
    const source = join(root, "source");
    const resourcesDir = join(root, "resources");
    const glmDir = join(resourcesDir, "glm");
    const targetPlatform = { os: "win32", arch: "arm64" };
    for (const platform of ["win32_arm64", "darwin_arm64"]) {
      const nativeDir = join(source, "build/koffi", platform);
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativeDir, "koffi.node"), platform);
    }
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "koffi" }));
    writeFileSync(join(source, "index.js"), "module.exports = {};");
    writeFileSync(join(source, "index.d.ts"), "export {};");
    expect(verifyStagedKoffi({ resourcesDir, targetPlatform })).toHaveLength(1);

    stageKoffiIntoBundledAgents({ koffiPackageRoot: source, glmDir, targetPlatform });

    const koffiRoot = join(glmDir, "node_modules/koffi");
    expect(existsSync(join(koffiRoot, "build/koffi/win32_arm64/koffi.node"))).toBe(true);
    expect(existsSync(join(koffiRoot, "build/koffi/darwin_arm64"))).toBe(false);
    expect(verifyStagedKoffi({ resourcesDir, targetPlatform })).toEqual([]);
    rmSync(join(koffiRoot, "index.js"));
    expect(verifyStagedKoffi({ resourcesDir, targetPlatform })).toHaveLength(1);
  });
});
