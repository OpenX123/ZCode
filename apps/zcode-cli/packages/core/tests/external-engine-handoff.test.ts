import { expect, test, vi } from "vitest";
import { ExternalEngineConnectionError, type ExternalEnginePort } from "@zcode/contracts";
import { runExternalEngineTurn } from "../src/external-engine/turn.js";
import { restoreExternalEngineConfig } from "../src/external-engine/session.js";
import { setup } from "./helpers/external-engine-runtime.js";

test("上下文交接只随首次真实输入发送，失败可重试，成功后冷恢复不再重复", async () => {
  const { runtime, input } = setup([]);
  let saved = {
    id: "handoff-entry",
    sessionID: runtime.sessionId,
    type: "external_engine_handoff",
    time: { created: 1, updated: 1 },
    data: { context: "父会话冻结背景" },
  };
  runtime.sessionStore!.sessionEntries = vi.fn(async () => [saved]);
  runtime.sessionStore!.saveSessionEntry = vi.fn(async (entry) => {
    if (entry.type === "external_engine_handoff") saved = entry as typeof saved;
  });
  const prompts: Array<Parameters<ExternalEnginePort["runTurn"]>[0]["prompt"]> = [];
  runtime.externalEnginePort!.runTurn = vi.fn(async (turn) => {
    prompts.push(turn.prompt);
    await turn.onSession("native-handoff-child");
    if (prompts.length === 1)
      throw new ExternalEngineConnectionError({
        code: "provider",
        method: "session/prompt",
        httpStatus: 502,
      });
    return { stopReason: "end_turn" };
  });
  await expect(runExternalEngineTurn(runtime, input)).rejects.toThrow();
  expect(JSON.stringify(prompts[0])).toContain("父会话冻结背景");
  expect(saved.data).not.toHaveProperty("consumedAt");
  await runExternalEngineTurn(runtime, input);
  expect(JSON.stringify(prompts[1])).toContain("父会话冻结背景");
  expect(input.input).toBe("example");
  expect(saved.data).toHaveProperty("consumedAt");
  expect(saved.data).toHaveProperty("nativeSessionId", "native-handoff-child");
  const restored = setup([]);
  restored.runtime.sessionStore!.sessionEntries = vi.fn(async () => [saved]);
  await restoreExternalEngineConfig(restored.runtime);
  const runTurn = vi.spyOn(restored.runtime.externalEnginePort!, "runTurn");
  await runExternalEngineTurn(restored.runtime, restored.input);
  expect(runTurn.mock.calls[0]![0].prompt).toEqual([{ type: "text", text: "example" }]);
});
