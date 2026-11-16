import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, begin, collect } = vi.hoisted(() => ({
  spawn: vi.fn(),
  begin: vi.fn(),
  collect: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn }));

const releaseModulePath = fileURLToPath(
  new URL("../src/packaging/remoteAssetRelease.ts", import.meta.url),
);
const cliModulePath = fileURLToPath(
  new URL("../src/packaging/stageRemoteAssetsCli.ts", import.meta.url),
);
const allTargets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const pnpmEntry = fileURLToPath(new URL("./fixture-pnpm.cjs", import.meta.url));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Windows 的 pnpm 由 Node 执行其 JS 入口；测试必须保留这层真实参数边界。
  vi.stubEnv("npm_execpath", pnpmEntry);
  begin.mockResolvedValue(undefined);
  collect.mockResolvedValue([]);
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  vi.doMock(releaseModulePath, () => ({
    SOURCE_SERVER_REMOTE_RELEASE_TARGETS: allTargets,
    beginSourceServerRemoteReleaseGeneration: begin,
    collectSourceServerRemoteReleaseArchives: collect,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock(releaseModulePath);
});

async function runCli(args: string[]) {
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, cliModulePath, ...args]);
  await import(cliModulePath);
}

describe("remote asset staging CLI", () => {
  it("wires the root Linux command to the existing staging entry", async () => {
    const rootPackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(rootPackage.scripts["prepare:remote-assets:linux"]).toBe(
      "pnpm --filter @zcode/server-cli stage:remote-assets --linux",
    );
  });

  it.each([
    [undefined, "production"],
    ["   ", "production"],
    [" TEST ", "test"],
    ["production", "production"],
  ])("stages only Linux targets with ZCODE_ENV=%s", async (input, expected) => {
    vi.stubEnv("ZCODE_ENV", input);
    await runCli(["--linux"]);
    expect(spawn.mock.calls.map((call) => call[0])).toEqual(Array(3).fill(process.execPath));
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      [pnpmEntry, "--filter", "@zcode/server-cli", "build"],
      [
        pnpmEntry,
        "--filter",
        "@zcode/server-cli",
        "exec",
        "tsx",
        "src/packaging/stageCli.ts",
        "--target",
        "linux-x64",
        "--skip-component-archives",
      ],
      [
        pnpmEntry,
        "--filter",
        "@zcode/server-cli",
        "exec",
        "tsx",
        "src/packaging/stageCli.ts",
        "--target",
        "linux-arm64",
        "--skip-component-archives",
        "--skip-agent-build",
      ],
    ]);
    for (const call of spawn.mock.calls) {
      expect(call[2].env.ZCODE_ENV).toBe(expected);
    }
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ["linux-x64", "linux-arm64"] }),
    );
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]!);
    expect(collect.mock.invocationCallOrder[0]).toBeGreaterThan(
      spawn.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("preserves all four targets and environment for the default entry", async () => {
    vi.stubEnv("ZCODE_ENV", undefined);
    await runCli([]);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(spawn.mock.calls.slice(1).map((call) => call[1][7])).toEqual(allTargets);
    for (const call of spawn.mock.calls) {
      expect(call[0]).toBe(process.execPath);
      expect(call[1][0]).toBe(pnpmEntry);
      expect(call[1]).not.toContain("--skip-component-archives");
    }
    expect(spawn.mock.calls[0]![2].env?.ZCODE_ENV).toBeUndefined();
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ targets: allTargets }));
  });

  it("rejects invalid Linux environments before invalidating or building", async () => {
    vi.stubEnv("ZCODE_ENV", "invalid");
    await expect(runCli(["--linux"])).rejects.toThrow(/Invalid ZCODE_ENV/);
    expect(begin).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it("does not publish when the second Linux target fails", async () => {
    spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", args.includes("linux-arm64") ? 1 : 0));
      return child;
    });
    await expect(runCli(["--linux"])).rejects.toThrow(/exited with code 1/);
    expect(begin).toHaveBeenCalledOnce();
    expect(collect).not.toHaveBeenCalled();
  });

  it("rejects missing pnpm JS entry without spawning a command", async () => {
    vi.stubEnv("npm_execpath", undefined);
    await expect(runCli(["--linux"])).rejects.toThrow(/npm_execpath is available/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });
});
