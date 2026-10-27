import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatePayload } from "@zcode/shared";
import { createDesktopPlatform } from "../src/renderer/src/desktopPlatform.js";

// 浏览器桥在模块初始化时读取独立 preload；本测试只验证更新的实际平台适配器。
vi.mock("../src/renderer/src/desktopBrowserPlatformBridge.js", () => ({
  desktopBrowserPlatformBridge: {},
}));
afterEach(() => vi.unstubAllGlobals());

describe("Desktop 更新平台适配器", () => {
  it("真实适配器透传全部更新命令和事件，注销函数保持原桥身份", async () => {
    const state: UpdateStatePayload = { kind: "update-available", enabled: true, version: "1.0.1" };
    let eventListener: ((state: UpdateStatePayload) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      getUpdateState: vi.fn(async () => state),
      checkForUpdates: vi.fn(async () => ({ kind: "available", version: "1.0.1" })),
      downloadUpdate: vi.fn(async () => ({ kind: "ready", version: "1.0.1" })),
      installUpdate: vi.fn(async () => ({ kind: "ready", version: "1.0.1" })),
      onUpdateState: vi.fn((listener: (state: UpdateStatePayload) => void) => {
        eventListener = listener;
        return unsubscribe;
      }),
    };
    vi.stubGlobal("window", { zcode: bridge });
    const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: false });
    expect(await platform.getUpdateState?.()).toBe(state);
    await expect(platform.checkForUpdates?.()).resolves.toEqual({
      kind: "available",
      version: "1.0.1",
    });
    await expect(platform.downloadUpdate?.()).resolves.toEqual({ kind: "ready", version: "1.0.1" });
    await expect(platform.installUpdate?.()).resolves.toEqual({ kind: "ready", version: "1.0.1" });
    const listener = vi.fn();
    expect(platform.onUpdateState?.(listener)).toBe(unsubscribe);
    eventListener?.({
      kind: "download-progress",
      enabled: true,
      progress: "25%",
      version: "1.0.1",
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "download-progress", progress: "25%" }),
    );
    expect(bridge.getUpdateState).toHaveBeenCalledOnce();
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    expect(bridge.downloadUpdate).toHaveBeenCalledOnce();
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });

  it("旧preload无更新桥时保持不支持，不伪造可用能力", () => {
    vi.stubGlobal("window", { zcode: {} });
    const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: false });
    expect(platform.getUpdateState).toBeUndefined();
    expect(platform.checkForUpdates).toBeUndefined();
    expect(platform.downloadUpdate).toBeUndefined();
    expect(platform.installUpdate).toBeUndefined();
    expect(platform.onUpdateState).toBeUndefined();
  });
});
