import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intranetConfigured: true,
  downloadNativeSearchTools: vi.fn(),
}));

// 用可切换的替身模拟“依赖源已配置 / 未配置时抛错”两种环境；已配置时显式注入中性主机，
// 不依赖仓库默认的内网地址（开源导出里默认地址为空），其余导出保持真实实现。
vi.mock("../../../scripts/intranetDefaults.mjs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const resolveActual = actual.resolveIntranetDepsBaseUrl as (env?: NodeJS.ProcessEnv) => string;
  return {
    ...actual,
    resolveIntranetDepsBaseUrl: (env?: NodeJS.ProcessEnv) => {
      if (!mocks.intranetConfigured) {
        throw new Error("Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST");
      }
      return resolveActual({ INTRANET_MACHINE_HOST: "intranet-deps.example", ...env });
    },
  };
});

vi.mock("../../../scripts/download-native-search-tools.mjs", () => ({
  downloadNativeSearchTools: mocks.downloadNativeSearchTools,
}));

import {
  NATIVE_SEARCH_DEPENDENCIES_DIR,
  LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET as CONFIG_LEGACY_SHA256,
  LEGACY_REMOTE_RIPGREP_VERSION as CONFIG_LEGACY_VERSION,
  resolveNativeSearchArtifactSource,
  resolveNativeSearchPrebuiltPlan,
} from "../../../scripts/native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "../../../scripts/prepare-native-search-tools.mjs";
import { verifyPrebuiltArchiveSha256 } from "../../../scripts/prebuilt-binary-extract.mjs";
import { verifyNativeSearchBinaryTarget } from "../../../scripts/native-search-tools-verify.mjs";
import {
  LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET,
  LEGACY_REMOTE_RIPGREP_VERSION,
  resolveRemoteNativeSearchPrebuiltPlan,
} from "../../../scripts/remote-native-search-tools-config.mjs";

type PrebuiltArtifact = {
  toolId: string;
  release: string;
  archivePath: string;
  archiveSha256: string;
  binaryPath: string;
  downloadUrl?: string;
};
type PrebuiltPlan = { platformKey: string; artifacts: PrebuiltArtifact[] };

const localTargets = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win32", "arm64"],
  ["win32", "x64"],
] as const;
const remoteTargets = localTargets.filter(([platform]) => platform !== "win32");

const temporaryDirectories: string[] = [];
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-prepare-native-search-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readSources(artifact: PrebuiltArtifact): {
  binary: { origin: string; toolId: string };
} {
  return JSON.parse(readFileSync(join(dirname(artifact.binaryPath), "SOURCES.json"), "utf8"));
}

beforeEach(() => {
  mocks.intranetConfigured = true;
  mocks.downloadNativeSearchTools.mockReset();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native search 归档来源判定", () => {
  it("内网依赖源已配置时判定为 intranet，计划同时带下载地址与同名仓库归档", () => {
    expect(resolveNativeSearchArtifactSource({})).toBe("intranet");
    for (const [platform, arch] of localTargets) {
      const plan = resolveNativeSearchPrebuiltPlan({ platform, arch, env: {} }) as PrebuiltPlan;
      for (const artifact of plan.artifacts) {
        expect(
          artifact.downloadUrl?.endsWith(`/${artifact.archivePath.split(/[\\/]/).pop()}`),
        ).toBe(true);
      }
    }
  });

  it("显式 NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL 在依赖源未配置时仍走 intranet", () => {
    mocks.intranetConfigured = false;
    expect(
      resolveNativeSearchArtifactSource({
        NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "https://deps.example.test/native-search-tools",
      }),
    ).toBe("intranet");
  });

  it("依赖源未配置时判定为 repository，计划不再解析下载地址", () => {
    mocks.intranetConfigured = false;
    expect(resolveNativeSearchArtifactSource({})).toBe("repository");
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: "linux",
      arch: "x64",
      env: {},
    }) as PrebuiltPlan;
    expect(plan.artifacts.every((artifact) => artifact.downloadUrl === undefined)).toBe(true);
  });

  it("本地与远端计划引用的仓库归档全部存在且摘要与固定值一致", () => {
    const plans = [
      ...localTargets.map(([platform, arch]) =>
        resolveNativeSearchPrebuiltPlan({ platform, arch }),
      ),
      ...remoteTargets.map(([platform, arch]) =>
        resolveRemoteNativeSearchPrebuiltPlan({ platform, arch }),
      ),
    ] as PrebuiltPlan[];
    for (const plan of plans) {
      for (const artifact of plan.artifacts) {
        expect(artifact.archivePath.startsWith(NATIVE_SEARCH_DEPENDENCIES_DIR)).toBe(true);
        expect(() =>
          verifyPrebuiltArchiveSha256(artifact.archivePath, artifact.archiveSha256),
        ).not.toThrow();
      }
    }
    // legacy rg13 常量只有一个所有者，远端配置只转出。
    expect(LEGACY_REMOTE_RIPGREP_VERSION).toBe(CONFIG_LEGACY_VERSION);
    expect(LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET).toBe(CONFIG_LEGACY_SHA256);
    const darwinRemote = resolveRemoteNativeSearchPrebuiltPlan({
      platform: "darwin",
      arch: "arm64",
    }) as PrebuiltPlan;
    expect(darwinRemote.artifacts.map(({ toolId, release }) => [toolId, release])).toEqual([
      ["ripgrep", CONFIG_LEGACY_VERSION],
    ]);
  });
});

describe("prepareNativeSearchTools", () => {
  it("intranet 来源原样委托既有下载链路，并在工具目录写入 intranet-mirror 声明", async () => {
    const outputDir = join(await createTemporaryDirectory(), "tools");
    const env = { NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "https://deps.example.test/native" };
    mocks.downloadNativeSearchTools.mockImplementation(async (options) => {
      const plan = resolveNativeSearchPrebuiltPlan(options) as PrebuiltPlan;
      for (const artifact of plan.artifacts) {
        mkdirSync(dirname(artifact.binaryPath), { recursive: true });
        writeFileSync(artifact.binaryPath, `${artifact.toolId}-downloaded`);
      }
      return plan;
    });

    const plan = (await prepareNativeSearchTools({
      platform: "linux",
      arch: "x64",
      outputDir,
      env,
    })) as PrebuiltPlan;

    expect(mocks.downloadNativeSearchTools).toHaveBeenCalledTimes(1);
    expect(mocks.downloadNativeSearchTools).toHaveBeenCalledWith({
      platform: "linux",
      arch: "x64",
      outputDir,
      env,
      prebuiltPlan: undefined,
    });
    for (const artifact of plan.artifacts) {
      expect(existsSync(join(dirname(artifact.binaryPath), "THIRD-PARTY-NOTICES.txt"))).toBe(true);
      expect(readSources(artifact).binary).toMatchObject({
        origin: "intranet-mirror",
        toolId: artifact.toolId,
      });
    }
  });

  it("repository 来源解包仓库归档，不触发下载；缓存命中时跳过解包但刷新声明", async () => {
    mocks.intranetConfigured = false;
    const outputDir = join(await createTemporaryDirectory(), "tools");

    const plan = (await prepareNativeSearchTools({
      platform: "linux",
      arch: "x64",
      outputDir,
      env: {},
    })) as PrebuiltPlan;

    expect(mocks.downloadNativeSearchTools).not.toHaveBeenCalled();
    expect(plan.artifacts.map(({ toolId }) => toolId)).toEqual(["bfs", "ugrep", "ripgrep"]);
    for (const artifact of plan.artifacts) {
      expect(existsSync(artifact.binaryPath)).toBe(true);
      expect(readSources(artifact).binary.origin).toBe("repository-archive");
      rmSync(join(dirname(artifact.binaryPath), "THIRD-PARTY-NOTICES.txt"));
    }

    const binaryBeforeCacheHit = readFileSync(plan.artifacts[0].binaryPath);
    await prepareNativeSearchTools({ platform: "linux", arch: "x64", outputDir, env: {} });
    expect(readFileSync(plan.artifacts[0].binaryPath)).toEqual(binaryBeforeCacheHit);
    for (const artifact of plan.artifacts) {
      expect(existsSync(join(dirname(artifact.binaryPath), "THIRD-PARTY-NOTICES.txt"))).toBe(true);
    }
  });

  it("仓库归档被改动时在替换任何产物前失败", async () => {
    const root = await createTemporaryDirectory();
    const dependenciesDir = join(root, "dependencies");
    cpSync(NATIVE_SEARCH_DEPENDENCIES_DIR, dependenciesDir, { recursive: true });
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: "linux",
      arch: "x64",
      outputDir: join(root, "tools"),
      dependenciesDir,
    }) as PrebuiltPlan;
    writeFileSync(plan.artifacts[1].archivePath, "tampered");

    await expect(
      prepareNativeSearchTools({ prebuiltPlan: plan, source: "repository" }),
    ).rejects.toThrow(/Invalid local native search archive/u);
    expect(plan.artifacts.some((artifact) => existsSync(artifact.binaryPath))).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")("Windows ZIP plain Node 与模块污染", () => {
  async function windowsFixture() {
    const root = await createTemporaryDirectory();
    const moduleRoot = join(root, "module path ' fixture");
    const moduleDir = join(moduleRoot, "Microsoft.PowerShell.Archive");
    const marker = join(root, "archive-module-loaded");
    const temporary = join(root, "temp path ' fixture");
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(temporary);
    // 自有模块只复现 CI 中 PS7 Archive 调用 Framework 不存在的三参数重载，不改系统模块。
    writeFileSync(
      join(moduleDir, "Microsoft.PowerShell.Archive.psm1"),
      `function Expand-Archive {
  param([string]$LiteralPath, [string]$DestinationPath, [switch]$Force)
  [System.IO.File]::WriteAllText($env:ZCODE_TEST_ARCHIVE_MARKER, 'loaded')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($LiteralPath)
  try { [System.IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $DestinationPath, $true) }
  finally { $archive.Dispose() }
}
Export-ModuleMember -Function Expand-Archive
`,
    );
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["PSMODULEPATH", "NODE_OPTIONS", "TEMP", "TMP"].includes(key.toUpperCase()),
      ),
    );
    Object.assign(env, {
      PSModulePath: `${moduleRoot};${join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/Modules")}`,
      ZCODE_TEST_ARCHIVE_MARKER: marker,
      TEMP: temporary,
      TMP: temporary,
      ZCODE_DEPS_BASE_URL: "",
      INTRANET_MACHINE_HOST: "",
      NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "",
    });
    const outputDir = join(root, "tools");
    const plan = resolveNativeSearchPrebuiltPlan({ platform: "win32", arch: "arm64", outputDir });
    return { root, marker, temporary, env, outputDir, plan };
  }

  it("污染 PSModulePath 时 plain Node 仍抽取真实 ARM64 归档且不加载 Archive 模块", async () => {
    const f = await windowsFixture();
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../../scripts/prepare-native-search-tools.mjs", import.meta.url)),
        "--platform",
        "win32",
        "--arch",
        "arm64",
        "--output-dir",
        f.outputDir,
      ],
      { env: f.env, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.marker)).toBe(false);
    for (const artifact of f.plan.artifacts) {
      verifyPrebuiltArchiveSha256(artifact.archivePath, artifact.archiveSha256);
      expect(() =>
        verifyNativeSearchBinaryTarget(artifact.binaryPath, { platform: "win32", arch: "arm64" }),
      ).not.toThrow();
      const bytes = readFileSync(artifact.binaryPath);
      expect(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)).toBe(0xaa64);
      expect(readSources(artifact).binary.origin).toBe("repository-archive");
    }
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it.each(["sha", "zip", "validation"])("%s 失败不覆盖原二进制并清理临时目录", async (failure) => {
    const f = await windowsFixture();
    const artifact = f.plan.artifacts[0]!;
    const binaryPath = join(f.root, "kept", artifact.binaryName);
    mkdirSync(dirname(binaryPath));
    writeFileSync(binaryPath, "previous-valid-output");
    const invalidZip = join(f.root, "invalid.zip");
    writeFileSync(invalidZip, "not a ZIP archive");
    const options = {
      ...artifact,
      archivePath: failure === "zip" ? invalidZip : artifact.archivePath,
      archiveSha256:
        failure === "sha"
          ? "0".repeat(64)
          : failure === "zip"
            ? createHash("sha256").update(readFileSync(invalidZip)).digest("hex")
            : artifact.archiveSha256,
      binaryPath,
      targetPlatform: "win32",
    };
    const worker = join(f.root, "extract-worker.mjs");
    writeFileSync(
      worker,
      `
import { extractPrebuiltBinary } from ${JSON.stringify(new URL("../../../scripts/prebuilt-binary-extract.mjs", import.meta.url).href)};
import { verifyNativeSearchBinaryTarget } from ${JSON.stringify(new URL("../../../scripts/native-search-tools-verify.mjs", import.meta.url).href)};
await extractPrebuiltBinary({ ...${JSON.stringify(options)}, validateBinary(path) {
  verifyNativeSearchBinaryTarget(path, { platform: 'win32', arch: 'arm64' });
  if (${JSON.stringify(failure)} === 'validation') throw new Error('fixture validation rejected');
}});
`,
    );
    const result = spawnSync(process.execPath, [worker], { env: f.env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      failure === "sha"
        ? "Archive SHA-256 mismatch"
        : failure === "validation"
          ? "fixture validation rejected"
          : "ExtractToDirectory",
    );
    expect(result.stderr).not.toContain("Failed to locate");
    expect(readFileSync(binaryPath, "utf8")).toBe("previous-valid-output");
    expect(existsSync(f.marker)).toBe(false);
    expect(readdirSync(f.temporary)).toEqual([]);
  });
});
