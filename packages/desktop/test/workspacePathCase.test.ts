import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeLocalWorkspacePathCase } from "../src/main/startupWorkspace.js";
import { canonicalizeExplicitStartupWorkspaceBootstrap } from "../src/main/startupWorkspaceDeepLinkGate.js";

// docs/desktop/engine-performance-1.1-spec.md「Windows 工作区路径大小写」。

const tree: Record<string, string[]> = {
  "C:\\": ["Users", "Windows"],
  "C:\\Users": ["Me", "Public"],
  "C:\\Users\\Me": ["Proj", "proj-other"],
  "C:\\Users\\Me\\Proj": ["src"],
};
const readDirectory = async (directory: string) => {
  const entries = tree[directory];
  if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return entries;
};

describe("canonicalizeLocalWorkspacePathCase", () => {
  it("把 Windows 本地路径每段改成磁盘实际大小写，盘符大写", async () => {
    await expect(
      canonicalizeLocalWorkspacePathCase("c:\\users\\me\\proj", {
        platform: "win32",
        readDirectory,
      }),
    ).resolves.toBe("C:\\Users\\Me\\Proj");
    await expect(
      canonicalizeLocalWorkspacePathCase("c:/USERS/me/PROJ/", { platform: "win32", readDirectory }),
    ).resolves.toBe("C:\\Users\\Me\\Proj");
  });

  it("已是实际写法时原样返回；读不到的段保留用户写法", async () => {
    await expect(
      canonicalizeLocalWorkspacePathCase("C:\\Users\\Me\\Proj", {
        platform: "win32",
        readDirectory,
      }),
    ).resolves.toBe("C:\\Users\\Me\\Proj");
    await expect(
      canonicalizeLocalWorkspacePathCase("c:\\users\\me\\Missing\\deeper", {
        platform: "win32",
        readDirectory,
      }),
    ).resolves.toBe("C:\\Users\\Me\\Missing\\deeper");
  });

  it("非 Windows 与网络路径不做处理", async () => {
    await expect(
      canonicalizeLocalWorkspacePathCase("/Users/me/Proj", { platform: "darwin", readDirectory }),
    ).resolves.toBe("/Users/me/Proj");
    await expect(
      canonicalizeLocalWorkspacePathCase("\\\\server\\share\\proj", {
        platform: "win32",
        readDirectory,
      }),
    ).resolves.toBe("\\\\server\\share\\proj");
  });

  it.runIf(process.platform === "win32")(
    "真实 Windows 文件系统：不同大小写写法得到同一路径",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ycode-case-"));
      try {
        await mkdir(join(root, "CaseProbe", "SubDir"), { recursive: true });
        // 只改写本用例创建的段：临时目录本身可能是 8.3 短名，短名不在规范化范围内。
        const lower = await canonicalizeLocalWorkspacePathCase(join(root, "caseprobe", "subdir"));
        const upper = await canonicalizeLocalWorkspacePathCase(join(root, "CASEPROBE", "SUBDIR"));
        expect(lower).toBe(upper);
        expect(lower).toMatch(/\\CaseProbe\\SubDir$/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("canonicalizeExplicitStartupWorkspaceBootstrap", () => {
  it("非显式工作区启动保持原样", async () => {
    const bootstrap = { restoreSession: true };
    await expect(canonicalizeExplicitStartupWorkspaceBootstrap(bootstrap)).resolves.toBe(bootstrap);
  });

  it.runIf(process.platform === "win32")("冷启动显式路径与预热目标一起改为实际大小写", async () => {
    const root = await mkdtemp(join(tmpdir(), "ycode-case-"));
    try {
      await mkdir(join(root, "StartupProbe"), { recursive: true });
      const typed = join(root, "startupprobe");
      const result = await canonicalizeExplicitStartupWorkspaceBootstrap({
        initialWorkspacePath: typed,
        initialWorkspacePurpose: "project",
        agentWarmupTargets: [{ workspacePath: typed }],
      });
      expect(result.initialWorkspacePath).toMatch(/\\StartupProbe$/u);
      expect(result.agentWarmupTargets).toEqual([{ workspacePath: result.initialWorkspacePath }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
