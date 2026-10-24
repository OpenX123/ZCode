import { describe, expect, it } from "vitest";
import {
  detectArchitectureMismatch,
  formatArchitectureMismatchDialogText,
} from "../src/main/desktopArchitectureGuard.js";

describe("detectArchitectureMismatch", () => {
  it("Apple 芯片上运行 x64 包（Rosetta 转译）应判定为不匹配", () => {
    expect(
      detectArchitectureMismatch({
        platform: "darwin",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toEqual({ binaryArch: "x64", nativeArch: "arm64" });
  });

  it("Windows on ARM 上转译运行也应判定为不匹配", () => {
    expect(
      detectArchitectureMismatch({
        platform: "win32",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toEqual({ binaryArch: "x64", nativeArch: "arm64" });
  });

  it("原生运行（未转译）应返回 null", () => {
    expect(
      detectArchitectureMismatch({
        platform: "darwin",
        binaryArch: "arm64",
        runningUnderARM64Translation: false,
      }),
    ).toBeNull();
  });

  it("非 macOS/Windows 平台即使报告转译也不误报", () => {
    expect(
      detectArchitectureMismatch({
        platform: "linux",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toBeNull();
  });
});

describe("formatArchitectureMismatchDialogText", () => {
  const mismatch = { binaryArch: "x64", nativeArch: "arm64" } as const;

  it("中文文案包含运行架构与推荐架构", () => {
    const text = formatArchitectureMismatchDialogText(mismatch, "zh-CN");
    expect(text.title).toBe("架构不匹配");
    expect(text.detail).toContain("x64");
    expect(text.detail).toContain("arm64");
    expect(text.dismissButton).toBe("知道了");
    expect(text.detail).not.toMatch(/官网|https?:/);
  });

  it("英文文案包含运行架构与推荐架构", () => {
    const text = formatArchitectureMismatchDialogText(mismatch, "en-US");
    expect(text.title).toBe("Architecture Mismatch");
    expect(text.detail).toContain("x64");
    expect(text.detail).toContain("arm64");
    expect(text.dismissButton).toBe("OK");
    expect(text.detail).not.toMatch(/https?:/);
  });
});
