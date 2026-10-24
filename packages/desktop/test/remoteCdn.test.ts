import { describe, expect, it } from "vitest";
import { resolveRemoteCdnBaseUrls } from "../src/main/remoteCdn.js";

describe("独立桌面 SSH 资源来源", () => {
  it("未配置镜像时不访问原厂 CDN", () => {
    expect(resolveRemoteCdnBaseUrls()).toEqual([]);
  });
  it("只使用用户显式配置的镜像", () => {
    expect(
      resolveRemoteCdnBaseUrls({ overrideBaseUrl: " https://mirror.example/releases/1/ " }),
    ).toEqual(["https://mirror.example/releases/1"]);
  });
});
