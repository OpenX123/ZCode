import { describe, expect, it, vi } from "vitest";
import {
  buildTurnToolDisallowlist,
  startPromptTurn,
} from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { SendInputOptions } from "../src/app/types.js";
import type { V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";

it("普通定时轮只隐藏 Cron 写工具，保留工作流和子代理能力", () => {
  expect(buildTurnToolDisallowlist({ automationId: "automation-1" })).toEqual([
    "CronCreate",
    "CronUpdate",
    "CronDelete",
  ]);
  expect(buildTurnToolDisallowlist({})).toBeUndefined();
});

describe("普通定时 turn 清理与当前执行约束共存", () => {
  it.each(["completed", "queued", "rejected", "thrown"])(
    "%s 不残留 定时任务身份，不丢 modelExecution/sharedContextRefs",
    async (outcome) => {
      const completion = Promise.withResolvers<void>();
      const sendInput = vi.fn(async () => {
        if (outcome === "thrown") throw new Error("admission failed");
        if (outcome === "rejected") return { kind: "rejected", reason: "no_active_turn" };
        if (outcome === "queued") return { kind: "queued", queueItemId: "q1" };
        return { kind: "started_turn", turnId: "turn-1", completion: completion.promise };
      });
      const record = {
        app: createFakeApp(undefined, {
          sendInput: sendInput as ReturnType<typeof createFakeApp>["sendInput"],
        }),
        workspace: { workspacePath: "/test/cron" },
        persistence: "immediate",
        traceContext: { traceId: "trace-cron", sessionId: "sess_test" },
        activeAutomationId: "previous-id",
      } as V4SessionRecordView;
      const modelExecution = { selectionScope: "execution" } satisfies NonNullable<
        SendInputOptions["modelExecution"]
      >;
      const sharedContextRefs: NonNullable<SendInputOptions["sharedContextRefs"]> = [];
      const run = startPromptTurn({ getRecord: () => record }, record, {
        content: "p",
        inputId: "input-1",
        automationId: "current-id",
        modelExecution,
        sharedContextRefs,
      });
      if (outcome === "thrown" || outcome === "rejected") {
        await expect(run).rejects.toThrow();
      } else {
        const started = await run;
        if (outcome === "completed") {
          expect(record.activeAutomationId).toBe("current-id");
          completion.resolve();
          await started.completion;
        }
      }
      expect(sendInput).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          modelExecution,
          sharedContextRefs,
          automationId: "current-id",
          toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
        }),
      );
      expect(record.activeAutomationId).toBe("previous-id");
      expect(record.activeBotDeliveryTarget).toBeUndefined();
    },
  );
});
