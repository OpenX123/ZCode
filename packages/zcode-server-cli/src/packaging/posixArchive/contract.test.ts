import { describe, expect, it } from "vitest";

import { posixReleaseArchiveModule } from "./module.js";

// 行为由完整/组件 packaging 与 Desktop B 边界测试验证；此处守住窄模块的公开面。
describe("posix-release-archive contract", () => {
  it("declares its module manifest", () => {
    expect(posixReleaseArchiveModule.id).toBe("posix-release-archive");
    expect(posixReleaseArchiveModule.requires).toEqual([]);
    expect(posixReleaseArchiveModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });
});
