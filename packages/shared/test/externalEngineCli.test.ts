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
