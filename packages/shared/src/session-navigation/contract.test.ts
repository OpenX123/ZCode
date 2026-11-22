import { describe, expect, it } from "vitest";

import { buildSessionDeepLink, parseSessionDeepLink } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("会话深度链接", () => {
  it.each(["C:\\Projects\\中文 & 示例", "/work/项目 #1"])(
    "保留完整工作区身份和路径：%s",
    (workspacePath) => {
      const locator = {
        taskId: "sess_example",
        workspacePath,
        workspaceIdentity: "ssh:example:workspace",
        sourceServerId: "saved-source",
      };
      expect(parseSessionDeepLink(buildSessionDeepLink(locator))).toEqual(locator);
    },
  );
  it("新链接使用 ycode://，旧 zcode:// 链接仍可解析", () => {
    const locator = { taskId: "sess_example", workspacePath: "/work" };
    expect(buildSessionDeepLink(locator).startsWith("ycode://session/open?")).toBe(true);
    expect(parseSessionDeepLink("zcode://session/open?taskId=sess_example&path=%2Fwork")).toEqual(
      locator,
    );
    expect(parseSessionDeepLink("ycode://session/open?taskId=sess_example&path=%2Fwork")).toEqual(
      locator,
    );
  });
  it.each([
    "https://session/open?taskId=a&path=/work",
    "zcode://session/open?taskId=a",
    "zcode://session/open?taskId=a&path=/work&token=secret",
    "zcode://session/open?taskId=a&taskId=b&path=/work",
    "zcode://user:password@session/open?taskId=a&path=/work",
    "zcode://session/open?taskId=a&path=%00",
    "ycode://session/open?taskId=a",
    "ycode://user:password@session/open?taskId=a&path=/work",
    "xcode://session/open?taskId=a&path=/work",
  ])("拒绝无效或含歧义的输入：%s", (url) => {
    expect(parseSessionDeepLink(url)).toBeNull();
  });
});
