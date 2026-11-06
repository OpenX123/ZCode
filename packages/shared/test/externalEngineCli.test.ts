import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { resolveExternalEngineCli, resolveExternalEngineLaunch } from "../src/node.js";
import { EXTERNAL_ENGINE_RUNTIMES } from "../src/external-engine/contract.js";

test("Windows PATH 大小写与 PATHEXT 顺序共用同一解析规则，支持带空格的 npm shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-windows-cli-"));
  try {
    const bin = join(root, "Program Files");
    await mkdir(bin);
    const shim = join(bin, "codex.CMD");
    await writeFile(shim, "fixture");
    await writeFile(join(bin, "codex.EXE"), "fixture");
    expect(
      await resolveExternalEngineCli("codex", { Path: bin, Pathext: ".CMD;.EXE" }, "win32"),
    ).toBe(shim);
    expect(await resolveExternalEngineCli("missing", { Path: bin }, "win32")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude 锁定 SDK 的 Windows 原生 optional 包由检测和连接共用，支持嵌套安装", async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-bundled-native-"));
  try {
    const runtime = EXTERNAL_ENGINE_RUNTIMES["claude-code"];
    const sdk = join(
      root,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
    );
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ main: "sdk.mjs" }));
    await writeFile(join(sdk, "sdk.mjs"), "fixture");
    const executable = join(
      sdk,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-win32-x64",
      "claude.exe",
    );
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    expect(await resolveExternalEngineLaunch(runtime, { PATH: "" }, root, "win32", "x64")).toBe(
      await realpath(executable),
    );
    await rm(executable);
    expect(
      await resolveExternalEngineLaunch(runtime, { PATH: "" }, root, "win32", "x64"),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 以下两份包装入口逐字取自 Windows 11 上 npm 全局安装的 claude.cmd / codex.cmd（CRLF）。
const NPM_CLAUDE_EXE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  "",
].join("\r\n");
const NPM_CODEX_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "",
].join("\r\n");

async function writeFixture(path: string, content = "fixture") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("Windows Claude npm 入口指向原生 claude.exe 时直接使用该文件，检测与连接共用", async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-windows-claude-exe-"));
  try {
    const bin = join(root, "npm global");
    const exe = join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await writeFixture(join(bin, "claude.cmd"), NPM_CLAUDE_EXE_SHIM);
    await writeFixture(exe);
    const env = { Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(await resolveExternalEngineCli("claude", env, "win32")).toBe(exe);
    // Host 检测与 adapter 的 CLAUDE_CODE_EXECUTABLE 共用同一解析结果，不回退 adapter 自带副本。
    expect(
      await resolveExternalEngineLaunch(
        EXTERNAL_ENGINE_RUNTIMES["claude-code"],
        env,
        join(root, "adapter"),
        "win32",
        "x64",
      ),
    ).toBe(exe);
    // 目标缺失时该入口不可用，继续使用 PATH 中后续目录的官方入口。
    await rm(exe);
    const later = join(root, "later");
    await writeFixture(join(later, "claude.exe"));
    expect(
      await resolveExternalEngineCli("claude", { ...env, Path: `${bin};${later}` }, "win32"),
    ).toBe(join(later, "claude.EXE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["x64", "x86_64-pc-windows-msvc"],
  ["arm64", "aarch64-pc-windows-msvc"],
])(
  "Windows Codex npm 入口 %s 解析到平台 optional 包的原生 codex.exe，跳过 cmd 与 node",
  async (arch, triple) => {
    const root = await mkdtemp(join(tmpdir(), "engine-windows-codex-"));
    try {
      const bin = join(root, "npm global");
      const packageRoot = join(bin, "node_modules", "@openai", "codex");
      await writeFixture(join(bin, "codex.cmd"), NPM_CODEX_SHIM);
      await writeFixture(join(packageRoot, "bin", "codex.js"));
      const nested = join(
        packageRoot,
        "node_modules",
        "@openai",
        `codex-win32-${arch}`,
        "vendor",
        triple,
        "bin",
        "codex.exe",
      );
      await writeFixture(nested);
      const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(await resolveExternalEngineCli("codex", env, "win32", arch)).toBe(nested);
      // adapter 把同一结果作为 CODEX_PATH，Host 版本/登录检测也执行同一原生文件。
      expect(
        await resolveExternalEngineLaunch(
          EXTERNAL_ENGINE_RUNTIMES.codex,
          env,
          join(root, "adapter"),
          "win32",
          arch,
        ),
      ).toBe(nested);
      // npm 提升布局：平台包位于全局 node_modules 根部。
      await rm(join(packageRoot, "node_modules"), { recursive: true, force: true });
      const hoisted = join(
        bin,
        "node_modules",
        "@openai",
        `codex-win32-${arch}`,
        "vendor",
        triple,
        "bin",
        "codex.exe",
      );
      await writeFixture(hoisted);
      expect(await resolveExternalEngineCli("codex", env, "win32", arch)).toBe(hoisted);
      // 原生文件缺失时保留 .cmd，由 adapter 的 cross-spawn 执行（原行为）；扩展名沿用 PATHEXT 大小写。
      await rm(hoisted);
      expect(await resolveExternalEngineCli("codex", env, "win32", arch)).toBe(
        join(bin, "codex.CMD"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("pnpm 形式的 %~dp0 相对入口同样解析到原生 codex.exe，包内 vendor 作为回退", async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-windows-codex-pnpm-"));
  try {
    const bin = join(root, "pnpm");
    const launcher = join(root, "global", "node_modules", "@openai", "codex", "bin", "codex.js");
    await writeFixture(launcher);
    await writeFixture(
      join(bin, "codex.CMD"),
      [
        "@SETLOCAL",
        '@IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe"  "%~dp0\\..\\global\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
        ") ELSE (",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        '  node  "%~dp0\\..\\global\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
        ")",
        "",
      ].join("\r\n"),
    );
    const vendor = join(
      dirname(dirname(launcher)),
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    await writeFixture(vendor);
    expect(
      await resolveExternalEngineCli("codex", { Path: bin, PATHEXT: ".CMD" }, "win32", "x64"),
    ).toBe(vendor);
    // 非官方 CLI 命令（npm 等）不解包装入口，继续交给调用方按批处理执行。
    await writeFixture(join(bin, "npm.cmd"), '"%~dp0\\..\\npm\\bin\\npm-cli.js" %*\r\n');
    expect(await resolveExternalEngineCli("npm", { Path: bin, PATHEXT: ".CMD" }, "win32")).toBe(
      join(bin, "npm.CMD"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["%dp0%", "%~dp0"])(
  "Windows Claude npm 包装入口 %s 解析到同份安装的 JS，不能直接交给 SDK spawn",
  async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), "engine-windows-claude-"));
    try {
      const relative = "node_modules\\@anthropic-ai\\claude-code\\cli.js";
      const cli = join(root, ...relative.split("\\"));
      await mkdir(dirname(cli), { recursive: true });
      await writeFile(cli, "fixture");
      await writeFile(
        join(root, "claude.CMD"),
        `@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%" "${prefix}\\${relative}" %*\r\n`,
      );
      expect(
        await resolveExternalEngineCli("claude", { Path: root, PATHEXT: ".CMD;.EXE" }, "win32"),
      ).toBe(cli);
      await rm(cli);
      expect(
        await resolveExternalEngineCli("claude", { Path: root, PATHEXT: ".CMD;.EXE" }, "win32"),
      ).toBeUndefined();
      await writeFile(join(root, "claude.EXE"), "fixture");
      expect(
        await resolveExternalEngineCli("claude", { Path: root, PATHEXT: ".CMD;.EXE" }, "win32"),
      ).toBe(join(root, "claude.EXE"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
