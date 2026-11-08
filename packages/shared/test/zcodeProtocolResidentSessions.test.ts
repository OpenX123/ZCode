import { describe, expect, it } from "vitest";
import {
  zcodeProtocolNotifications,
  zcodeResidentSessionsNotificationSchema,
} from "../src/zcode-protocol/index.js";

// 规则见 apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md「常驻会话数通知」：
// CLI 会话注册表的 record 数变化时整值通知 Host；收到第一条之前 Host 按未知（失败关闭）处理。
describe("ZCode Protocol 常驻会话数通知", () => {
  it("方法名固定，载荷为非负整数计数与从 1 起的序号", () => {
    expect(zcodeProtocolNotifications.processResidentSessions).toBe("process/residentSessions");
    expect(
      zcodeResidentSessionsNotificationSchema.parse({ residentSessionCount: 0, sequence: 1 }),
    ).toEqual({ residentSessionCount: 0, sequence: 1 });
    expect(
      zcodeResidentSessionsNotificationSchema.safeParse({ residentSessionCount: 3, sequence: 42 })
        .success,
    ).toBe(true);
  });

  it("拒绝负数、小数、缺字段、零序号与未知字段", () => {
    for (const params of [
      { residentSessionCount: -1, sequence: 1 },
      { residentSessionCount: 1.5, sequence: 1 },
      { residentSessionCount: 1 },
      { sequence: 1 },
      { residentSessionCount: 1, sequence: 0 },
      { residentSessionCount: 1, sequence: 1, sessionIds: ["session_a"] },
    ]) {
      expect(zcodeResidentSessionsNotificationSchema.safeParse(params).success).toBe(false);
    }
  });
});
