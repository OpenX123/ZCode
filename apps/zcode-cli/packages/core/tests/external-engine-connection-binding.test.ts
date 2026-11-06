import { expect, test, vi } from "vitest";
import { createSessionId, SessionEventType, type ExternalEnginePort } from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function port(onPrepare: (input: Parameters<ExternalEnginePort["prepareSession"]>[0]) => void) {
  return {
    prepareSession: vi.fn<ExternalEnginePort["prepareSession"]>(async (input) => {
      onPrepare(input);
      await input.onConnectionProfile?.(input.connectionProfileId ?? "official");
      await input.onConfigOptions([]);
    }),
    runTurn: vi.fn(),
    setConfigOption: vi.fn(),
    closeSession: vi.fn(),
  } satisfies ExternalEnginePort;
}

test("草稿首次准备接收所选连接配置，并在配置事件中只读投影绑定", async () => {
  const sessionId = createSessionId();
  const eventStore = createTestSessionEventStore();
  const seen: Array<string | undefined> = [];
  const externalEnginePort = port((input) => seen.push(input.connectionProfileId));
  const runtime = new AgentRuntime(
    sessionId,
    { engine: "claude-code", workingDirectory: "/workspace" },
    { eventStore, externalEnginePort },
  );
  await runtime.prepareExternalEngineSession({ connectionProfileId: "gateway-a" });
  expect(seen).toEqual(["gateway-a"]);
  const configEvents = (await eventStore.getEvents(sessionId)).filter(
    (event) => event.type === SessionEventType.ExternalEngineConfigUpdated,
  );
  expect(configEvents.at(-1)?.payload).toMatchObject({
    engineConfigState: "ready",
    engineConnectionProfileId: "gateway-a",
  });
  expect(JSON.stringify(configEvents)).not.toMatch(/apiKey|credential/i);
  await runtime.closeBrowserSession();
});

test("已有原生会话不能经准备入口改写连接身份", async () => {
  const seen: Array<string | undefined> = [];
  const runtime = new AgentRuntime(
    createSessionId(),
    { engine: "codex", externalSessionId: "native-history", workingDirectory: "/workspace" },
    {
      eventStore: createTestSessionEventStore(),
      externalEnginePort: port((input) => seen.push(input.connectionProfileId)),
    },
  );
  await runtime.prepareExternalEngineSession({ connectionProfileId: "gateway-a" });
  expect(seen).toEqual([undefined]);
  await runtime.closeBrowserSession();
});
