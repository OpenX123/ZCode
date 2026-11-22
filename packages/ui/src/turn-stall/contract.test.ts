import { describe, expect, it } from "vitest";
import { longRunningToolExample, stalledWaitingModelExample } from "./contract.example.js";
import { resolveConversationStallState } from "./model.js";

describe("turn-stall 合同", () => {
  it("等待模型超过 5 分钟升级为警告", () => {
    expect(resolveConversationStallState(stalledWaitingModelExample)).toEqual({
      kind: "idle",
      level: "warning",
      idleMinutes: 6,
    });
  });

  it("长时间运行的工具不视为无响应", () => {
    expect(resolveConversationStallState(longRunningToolExample)).toEqual({
      kind: "tool",
      toolName: "Bash",
      elapsedMinutes: 10,
    });
  });
});
