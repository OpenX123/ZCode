import { describe, expect, it } from "vitest";
import {
  desktopUpdatePreferencesPatch,
  getDesktopUpdateAction,
  getDesktopUpdateProgress,
  isDesktopUpdateDismissible,
  resolveDesktopUpdatePreferences,
} from "./contract.js";

describe("桌面更新 UI 动作契约", () => {
  it("根据 Main 状态选择下载、重开和对应重试", () => {
    expect(getDesktopUpdateAction({ kind: "idle", enabled: true })).toBeNull();
    expect(
      getDesktopUpdateAction({ kind: "update-available", enabled: true, version: "1.0.1" }),
    ).toBe("download");
    expect(
      getDesktopUpdateAction({ kind: "update-downloaded", enabled: true, version: "1.0.1" }),
    ).toBe("install");
    expect(getDesktopUpdateAction({ kind: "error", enabled: true, message: "network" })).toBe(
      "check",
    );
    expect(
      getDesktopUpdateAction({
        kind: "error",
        enabled: true,
        message: "network",
        version: "1.0.1",
      }),
    ).toBe("download");
    expect(
      getDesktopUpdateAction({ kind: "update-available", enabled: false, version: "1.0.1" }),
    ).toBeNull();
  });
  it("发布矩阵外的平台只打开 Release 页面，缺少地址时不提供动作", () => {
    const releaseUrl = "https://github.com/OpenX123/ZCode/releases/tag/v1.0.1";
    const manual = {
      kind: "update-available",
      enabled: true,
      version: "1.0.1",
      manualDownload: true,
    } as const;
    expect(getDesktopUpdateAction({ ...manual, releaseUrl })).toBe("open-release");
    expect(getDesktopUpdateAction(manual)).toBeNull();
    expect(isDesktopUpdateDismissible({ ...manual, releaseUrl })).toBe(true);
  });
  it("只有发现新版与已知版本的下载失败可以跳过，下载中与已就绪始终展示", () => {
    expect(
      isDesktopUpdateDismissible({ kind: "update-available", enabled: true, version: "1.0.8" }),
    ).toBe(true);
    expect(
      isDesktopUpdateDismissible({
        kind: "error",
        enabled: true,
        version: "1.0.8",
        message: "checksum",
      }),
    ).toBe(true);
    expect(isDesktopUpdateDismissible({ kind: "error", enabled: true, message: "network" })).toBe(
      false,
    );
    expect(
      isDesktopUpdateDismissible({
        kind: "download-progress",
        enabled: true,
        version: "1.0.8",
        progress: "10",
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateDismissible({ kind: "update-downloaded", enabled: true, version: "1.0.8" }),
    ).toBe(false);
    expect(
      isDesktopUpdateDismissible({ kind: "update-available", enabled: false, version: "1.0.8" }),
    ).toBe(false);
  });
  it("下载期间禁止重复动作，兼容百分号并限制进度范围", () => {
    expect(
      getDesktopUpdateAction({ kind: "download-progress", enabled: true, progress: "50%" }),
    ).toBeNull();
    for (const [value, expected] of [
      ["50%", 50],
      ["500", 100],
      ["-2", 0],
      ["unknown", 0],
    ] as const) {
      expect(
        getDesktopUpdateProgress({ kind: "download-progress", enabled: true, progress: value }),
      ).toBe(expected);
    }
  });
});

describe("自动更新偏好（1.5.0）", () => {
  it("缺席按开启，显式 false 关闭", () => {
    expect(resolveDesktopUpdatePreferences(null)).toEqual({ autoCheck: true, autoDownload: true });
    expect(
      resolveDesktopUpdatePreferences({
        desktopUpdateAutoCheck: false,
        desktopUpdateAutoDownload: true,
      }),
    ).toEqual({ autoCheck: false, autoDownload: true });
  });

  it("补丁只写入变化的设置字段", () => {
    expect(desktopUpdatePreferencesPatch({ autoDownload: false })).toEqual({
      desktopUpdateAutoDownload: false,
    });
    expect(desktopUpdatePreferencesPatch({ autoCheck: true })).toEqual({
      desktopUpdateAutoCheck: true,
    });
  });

  it("已下载的更新动作为重启以更新（install），且不可关闭", () => {
    const ready = { kind: "update-downloaded" as const, enabled: true, version: "1.5.0" };
    expect(getDesktopUpdateAction(ready)).toBe("install");
    expect(isDesktopUpdateDismissible(ready)).toBe(false);
  });
});
