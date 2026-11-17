import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentElectronRendererContentSize } from "./e2e/helpers/desktop-app.js";

afterEach(() => vi.unstubAllGlobals());

describe("真实 Electron 尺寸 helper 的原异常保全", () => {
  function install(immediateMismatch: boolean) {
    let reads = 0;
    const target = {
      id: 7,
      isDestroyed: () => false,
      webContents: { getURL: () => "fixture://renderer", getZoomFactor: () => 1 },
      getContentSize: () => {
        reads++;
        return reads === 1
          ? [1200, 800]
          : reads === 2 && !immediateMismatch
            ? [1840, 800]
            : [1536, 816];
      },
      setContentSize: vi.fn(),
      focus: vi.fn(),
    };
    const electron = { BrowserWindow: { getAllWindows: () => [target], fromId: () => target } };
    const viewport = new Error("fixture viewport primary");
    vi.stubGlobal("browser", {
      getUrl: async () => "fixture://renderer",
      electron: {
        execute: async (fn: (...args: any[]) => unknown, ...args: unknown[]) =>
          fn(electron, ...args),
      },
      waitUntil: async () => {
        throw viewport;
      },
    });
    return { target, viewport };
  }

  it("立即尺寸不符与restore同时失败时，保留requested原错误和附属错误", async () => {
    const { target } = install(true);
    const failure = await setCurrentElectronRendererContentSize(1840, 800).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect((aggregate.cause as Error).message).toContain(
      "没有应用: requested=1840x800; applied=1536x816",
    );
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[1] as Error).message).toContain("恢复失败: expected=1200x800");
    expect(target.setContentSize.mock.calls).toEqual([
      [1840, 800],
      [1200, 800],
    ]);
  });

  it("viewport失败与restore同时失败时，保留原cause及独立restore错误", async () => {
    const { viewport } = install(false);
    const failure = await setCurrentElectronRendererContentSize(1840, 800).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect((aggregate.cause as Error).message).toContain("renderer viewport 没有收敛");
    expect((aggregate.cause as Error).cause).toBe(viewport);
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[1] as Error).message).toContain("恢复失败");
  });

  it("成功路径保持原尺寸/focus/viewport检查与返回快照", async () => {
    const { target } = install(false);
    vi.stubGlobal("browser", {
      getUrl: async () => "fixture://renderer",
      electron: {
        execute: async (fn: (...args: any[]) => unknown, ...args: unknown[]) =>
          fn({ BrowserWindow: { getAllWindows: () => [target] } }, ...args),
      },
      waitUntil: vi.fn(async () => undefined),
    });
    expect(await setCurrentElectronRendererContentSize(1840, 800)).toEqual({
      width: 1200,
      height: 800,
      windowId: 7,
    });
    expect(target.setContentSize.mock.calls).toEqual([[1840, 800]]);
    expect(target.focus).toHaveBeenCalledOnce();
  });
});
