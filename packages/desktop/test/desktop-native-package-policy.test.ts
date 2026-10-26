import { describe, expect, it } from "vitest";
import {
  createDesktopNativePackagePrunePatterns,
  createDesktopRendererPackagePrunePatterns,
  findDesktopRendererPackageViolations,
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "../scripts/desktop-native-package-policy.mjs";

describe("desktop native package policy", () => {
  it("应裁剪 Canvas、node-pty 安装机产物和所有非目标平台 prebuild", () => {
    const patterns = createDesktopNativePackagePrunePatterns("darwin-arm64");

    expect(patterns).toContain("!node_modules/@napi-rs/canvas/**");
    expect(patterns).toContain("!node_modules/@napi-rs/canvas-*/**");
    expect(patterns).toContain("!node_modules/@lydell/node-pty-*/**");
    expect(patterns).toContain("!node_modules/node-pty/build/**");
    expect(patterns).toContain("!node_modules/node-pty/bin/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/darwin-x64/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/win32-arm64/**");
    expect(patterns).not.toContain("!node_modules/node-pty/prebuilds/darwin-arm64/**");
  });

  it("应接受仅包含目标平台且正确 unpack 的 native 资源", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        "pack   : /node_modules/node-pty/package.json",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([]);
  });

  it("应同时拒绝跨平台包、安装机产物和仍留在 asar payload 的 native", () => {
    const entries = parseAsarListWithPackState(
      [
        "pack   : \\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.node",
        "unpack : /node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node",
        "unpack : /node_modules/node-pty/build/Release/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/win32-x64/pty.node",
        "pack   : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([
      expect.stringContaining("Canvas native"),
      expect.stringContaining("平台源包"),
      expect.stringContaining("安装机生成"),
      expect.stringContaining("非目标平台"),
      expect.stringContaining("packed payload"),
    ]);
  });
});

describe("desktop renderer package policy", () => {
  it("仅排除已内联浏览器包，保留Node外置依赖与浏览器静态资源", () => {
    const patterns = createDesktopRendererPackagePrunePatterns();
    expect(patterns).toHaveLength(5);
    expect(patterns.every((pattern) => pattern.startsWith("!node_modules/"))).toBe(true);
    const entries = parseAsarListWithPackState(
      [
        "pack : /out/renderer/assets/mermaid.js",
        "pack : /out/plugin-sandbox/vendor/echarts.min.js",
        "pack : /node_modules/ssh2/lib/client.js",
        "pack : /node_modules/@larksuiteoapi/node-sdk/lib/index.js",
        "pack : /node_modules/pdfjs-dist/build/pdf.mjs",
        "pack : /node_modules/@extend-ai/react-xlsx/dist/duke_sheets_wasm_bg.wasm",
        "pack : /THIRD-PARTY-NOTICES.md",
        "pack : /licenses/electron/LICENSE",
      ].join("\n"),
    );
    expect(findDesktopRendererPackageViolations(entries)).toEqual([]);
  });

  it("构建后拒绝重复renderer目录回流", () => {
    const entries = parseAsarListWithPackState(
      [
        "pack : /node_modules/mermaid/dist/mermaid.js",
        "pack : /node_modules/echarts/package.json",
        "pack : /node_modules/lucide-react/dist/index.js",
        "pack : /node_modules/highlight.js/lib/index.js",
        "pack : /node_modules/world-atlas/countries-110m.json",
      ].join("\n"),
    );
    const violations = findDesktopRendererPackageViolations(entries);
    expect(violations).toHaveLength(5);
    expect(violations.every((message) => message.includes("已内联的 renderer 依赖"))).toBe(true);
  });
});
