import { describe, expect, it } from "vitest";
import tsupConfig, { resolveDesktopTsupBundleSecurityOptions } from "../tsup.config";

type EsbuildLikeOptions = {
  chunkNames?: string;
  legalComments?: string;
};

function getChunkNames(configName: string): string | undefined {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();

  const esbuildOptions: EsbuildLikeOptions = {};
  target?.esbuildOptions?.(esbuildOptions);
  return esbuildOptions.chunkNames;
}

function getExternal(configName: string): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  expect(Array.isArray(target?.external)).toBe(true);
  return target?.external as string[];
}

function getNoExternal(configName: string): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  expect(Array.isArray(target?.noExternal)).toBe(true);
  return target?.noExternal as string[];
}

function getDefines(configName: string): Record<string, string> {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  return target?.define ?? {};
}

describe("desktop tsup chunk isolation", () => {
  it("ZIP 解包器应外置，避免 Electron ESM 启动时动态 require fs 崩溃", () => {
    for (const name of ["main", "host", "scheduler"]) expect(getExternal(name)).toContain("yauzl");
  });
  it("main 构建应将 chunk 输出到 main 子目录，避免覆盖 host 构建产物", () => {
    expect(getChunkNames("main")).toBe("main/chunk-[hash]");
  });

  it("host 构建应将 chunk 输出到 host 子目录，避免覆盖 main 构建产物", () => {
    expect(getChunkNames("host")).toBe("host/chunk-[hash]");
  });

  it("main/host 构建应外置飞书 SDK，避免 Electron ESM 动态 require 崩溃", () => {
    expect(getExternal("main")).toContain("@larksuiteoapi/node-sdk");
    expect(getExternal("host")).toContain("@larksuiteoapi/node-sdk");
  });

  it("main/host 构建应外置 yaml，避免 Electron ESM 动态 require 崩溃", () => {
    expect(getExternal("main")).toContain("yaml");
    expect(getExternal("host")).toContain("yaml");
  });

  it("main/host/scheduler 应内联 CUA producer，安装包不能依赖被排除的 @zcode node_modules", () => {
    for (const configName of ["main", "host", "scheduler"]) {
      expect(getNoExternal(configName)).toContain("@zcode/zcode-cua");
    }
  });

  it("main/host/scheduler 应内联 Provider workspace 包，Electron 不能直接加载 TypeScript 源码", () => {
    for (const configName of ["main", "host", "scheduler"]) {
      expect(getNoExternal(configName)).toContain("@zcode/provider");
      expect(getNoExternal(configName)).toContain("@zcode/provider-node");
    }
  });

  it("生产构建应压缩 main/host/preload 且不生成 sourcemap", () => {
    expect(resolveDesktopTsupBundleSecurityOptions({ NODE_ENV: "production" })).toEqual({
      keepNames: true,
      minify: true,
      sourcemap: false,
    });
  });

  it("开发构建应保留 sourcemap 方便本地调试", () => {
    expect(resolveDesktopTsupBundleSecurityOptions({ NODE_ENV: "development" })).toEqual({
      keepNames: false,
      minify: false,
      sourcemap: true,
    });
  });

  it("E2E coverage 构建应关闭压缩并保留 sourcemap", () => {
    expect(
      resolveDesktopTsupBundleSecurityOptions({
        NODE_ENV: "production",
        ZCODE_E2E_COVERAGE: "1",
      }),
    ).toEqual({
      keepNames: false,
      minify: false,
      sourcemap: true,
    });
  });

  it("安装包身份与后端环境作为两个编译期常量注入每个 bundle", () => {
    // 打包后的应用不能依赖机器环境变量：ZCODE_PREVIEW_IDENTITY 在构建时折叠成 __ZCODE_PRODUCT_FLAVOR__。
    for (const entry of ["main", "host", "preload"] as const) {
      const defines = getDefines(entry);
      expect(defines).toHaveProperty("__ZCODE_ENV__");
      expect(defines).toHaveProperty("__ZCODE_PRODUCT_FLAVOR__");
      expect(['"production"', '"preview"']).toContain(defines.__ZCODE_PRODUCT_FLAVOR__);
    }
  });

  it("所有构建均不注入官方遥测与 CDN 默认值", () => {
    for (const entry of ["main", "host", "preload"] as const) {
      expect(getDefines(entry)).not.toHaveProperty("__ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__");
      expect(getDefines(entry)).not.toHaveProperty("__ZCODE_REMOTE_CDN_RELEASE_ROOTS__");
    }
  });

  it("所有 tsup 子构建都应关闭 esbuild legal comments 输出", () => {
    for (const configName of ["main", "host", "preload"]) {
      const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
      const target = configs.find((config) => config.name === configName);
      expect(target).toBeDefined();

      const esbuildOptions: EsbuildLikeOptions = {};
      target?.esbuildOptions?.(esbuildOptions);
      expect(esbuildOptions.legalComments).toBe("none");
    }
  });
});
