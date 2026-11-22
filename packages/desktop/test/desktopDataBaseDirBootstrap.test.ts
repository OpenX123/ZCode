import { describe, expect, it } from "vitest";
import {
  extractBootstrapDataBaseDir,
  resolveBootstrapSettingsFile,
} from "../src/main/desktopDataBaseDirBootstrap.js";

describe("desktopDataBaseDirBootstrap", () => {
  it("应从 bootstrap setting 中提取并裁剪 dataBaseDir", () => {
    expect(
      extractBootstrapDataBaseDir({
        dataBaseDir: "  /tmp/zcode-data  ",
      }),
    ).toBe("/tmp/zcode-data");
  });

  it("应忽略无效的 bootstrap 配置", () => {
    expect(extractBootstrapDataBaseDir(null)).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: "" })).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: 123 })).toBeNull();
  });

  it("应拼出默认 bootstrap setting 路径", () => {
    const result = resolveBootstrapSettingsFile("/Users/tester");
    // Windows 下 path.join 使用反斜杠，统一为正斜杠后再比较
    expect(result.replace(/\\/g, "/")).toBe(
      // 新旧目录都不存在时按迁移后的布局解析为 ~/.ycode（docs/desktop/ycode-data-dir-migration.md）。
      "/Users/tester/.ycode/v2/setting.json",
    );
  });
});
