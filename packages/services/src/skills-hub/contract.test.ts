import { describe, expect, it } from "vitest";

import { exampleCreateSkillsHub } from "./contract.example.js";
import { createSkillsHub } from "./skillsHub.js";

describe("skills hub 服务契约", () => {
  it("不可用时不扫描、不写入，返回 available=false", async () => {
    const hub = createSkillsHub({
      homeDir: () => {
        throw new Error("不应读取主目录");
      },
      isAvailable: () => false,
      choices: { read: async () => ({}), write: async () => {} },
    });
    await expect(hub.sync()).resolves.toMatchObject({ available: false });
    await expect(hub.prune(["x"])).resolves.toMatchObject({ available: false });
  });

  it("示例装配暴露完整接口", () => {
    const hub = exampleCreateSkillsHub("/nonexistent-home");
    expect(typeof hub.sync).toBe("function");
    expect(typeof hub.onDidChange).toBe("function");
  });
});
