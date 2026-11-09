// W7：完成事件标记本次物理请求是否流式收到推理内容，供 tokens/s 区分隐藏推理
// （docs/desktop/turn-output-rate-spec.md §2）。
import { describe, expect, it } from "vitest";
import type { ModelNetworkStatusEvent } from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import { executeAdapterStreamText } from "./test-adapter-model.js";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";

async function completedStatus(chunks: unknown[]) {
  const status: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      return {
        fullStream: (async function* () {
          yield { type: "start" };
          for (const chunk of chunks) yield chunk;
          yield {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 5, totalTokens: 6 },
          };
        })(),
      } as never;
    },
  };
  const adapter = new TestAiSdkModelAdapter({
    registry: new TestProviderConfigFixture({
      providers: {
        test: { kind: "custom", createLanguageModel: (modelId) => ({ modelId }) as never },
      },
    }),
    runtime,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
  });
  for await (const _event of executeAdapterStreamText(adapter, {
    providerId: "test",
    modelId: "model-a",
    messages: [{ role: "user" as const, content: "hi" }],
    statusSink: { publish: (event: ModelNetworkStatusEvent) => void status.push(event) },
  })) {
    // 只关心状态事件。
  }
  return status.find((event) => event.type === "model_request_completed");
}

describe("model_request_completed.reasoningContentStreamed", () => {
  it("收到非空推理 delta 时为 true", async () => {
    const event = await completedStatus([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thinking" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-delta", id: "t1", text: "done" },
    ]);
    expect(event).toMatchObject({ reasoningContentStreamed: true });
  });

  it("只有正文（隐藏推理或无推理）时为 false", async () => {
    const event = await completedStatus([{ type: "text-delta", id: "t1", text: "done" }]);
    expect(event).toMatchObject({ reasoningContentStreamed: false });
  });
});
