import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  outputs: [] as Array<{ error?: Error; stdout?: string }>,
  pending: [] as Array<(error: Error | null, stdout: string) => void>,
  deferred: false,
  execFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: childProcess.execFile,
  };
});

const COMSPEC = "C:\\Windows\\System32\\cmd.exe";

beforeEach(() => {
  vi.resetModules();
  childProcess.execFile.mockReset();
  childProcess.outputs = [];
  childProcess.pending = [];
  childProcess.deferred = false;
  childProcess.execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (childProcess.deferred) {
        childProcess.pending.push(callback);
        return;
      }
      const next = childProcess.outputs.shift() ?? { stdout: "Active code page: 936" };
      callback(next.error ?? null, next.stdout ?? "");
    },
  );
});

async function loadOutputEncoding() {
  return await import("../src/exec/outputEncoding.js");
}

describe("Windows 输出代码页解析", () => {
  it("每个进程只异步查询一次 chcp，后续工具执行复用同一结果", async () => {
    const { resolveLegacyExecutionOutputEncoding } = await loadOutputEncoding();
    const processEnv = { ComSpec: COMSPEC };
    for (let index = 0; index < 3; index++) {
      await expect(
        resolveLegacyExecutionOutputEncoding({ platform: "win32", processEnv }),
      ).resolves.toBe("cp936");
    }
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    expect(childProcess.execFile).toHaveBeenCalledWith(
      COMSPEC,
      ["/d", "/s", "/c", "chcp"],
      expect.objectContaining({ timeout: 1_000, windowsHide: true }),
      expect.any(Function),
    );
  });

  it("并发解析共用在途查询，不在回包前重复启动 cmd.exe", async () => {
    const { resolveLegacyExecutionOutputEncoding } = await loadOutputEncoding();
    childProcess.deferred = true;
    const processEnv = { ComSpec: COMSPEC };
    const first = resolveLegacyExecutionOutputEncoding({ platform: "win32", processEnv });
    const second = resolveLegacyExecutionOutputEncoding({ platform: "win32", processEnv });
    await Promise.resolve();
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    childProcess.pending.shift()?.(null, "活动代码页: 437");
    await expect(Promise.all([first, second])).resolves.toEqual(["cp437", "cp437"]);
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });

  it("查询失败也只尝试一次，并按 locale 回退旧编码", async () => {
    const { resolveLegacyExecutionOutputEncoding } = await loadOutputEncoding();
    childProcess.outputs.push({ error: new Error("spawn timeout") });
    const processEnv = { ComSpec: COMSPEC, LANG: "zh_CN" };
    await expect(
      resolveLegacyExecutionOutputEncoding({ platform: "win32", processEnv }),
    ).resolves.toBe("gb18030");
    await expect(
      resolveLegacyExecutionOutputEncoding({ platform: "win32", processEnv }),
    ).resolves.toBe("gb18030");
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });

  it("UTF-8 代码页仍按 locale 提供旧编码兜底，覆盖项与非 Windows 不查询", async () => {
    const { resolveLegacyExecutionOutputEncoding } = await loadOutputEncoding();
    childProcess.outputs.push({ stdout: "Active code page: 65001" });
    await expect(
      resolveLegacyExecutionOutputEncoding({
        platform: "win32",
        // locale 推断还会拼接运行机 Intl locale；zh 优先匹配，避免断言随测试机语言变化。
        processEnv: { ComSpec: COMSPEC, LANG: "zh_CN" },
      }),
    ).resolves.toBe("gb18030");
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);

    await expect(
      resolveLegacyExecutionOutputEncoding({
        platform: "win32",
        processEnv: { ComSpec: "D:\\Tools\\cmd.exe", ZCODE_WINDOWS_OUTPUT_ENCODING: "cp1252" },
      }),
    ).resolves.toBe("cp1252");
    await expect(
      resolveLegacyExecutionOutputEncoding({ platform: "linux", processEnv: {} }),
    ).resolves.toBeNull();
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });
});
