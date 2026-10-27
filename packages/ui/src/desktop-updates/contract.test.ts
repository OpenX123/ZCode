import { describe, expect, it } from "vitest";
import { getDesktopUpdateAction, getDesktopUpdateProgress } from "./contract.js";

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
