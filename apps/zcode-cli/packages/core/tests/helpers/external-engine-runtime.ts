import { vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
  createMessageId,
  type MessagePart,
} from "@zcode/contracts";
import { TurnMachineImpl } from "../../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";

export function setup(updates: Record<string, unknown>[]) {
  const parts = new Map<string, MessagePart>();
  const events: Record<string, unknown>[] = [];
  const runtime = {
    sessionId: createSessionId(),
    config: { engine: "codex" },
    engineConfigOptions: [],
    sessionPersisted: true,
    workingDirectory: "/workspace",
    isRemoteWorkspace: () => false,
    sessionStore: { updateSession: vi.fn() },
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    appendEvent: vi.fn(async (event: Record<string, unknown>) => {
      events.push(event);
    }),
    persistAssistantMessage: vi.fn(),
    persistPart: vi.fn(async (part: MessagePart) => {
      parts.set(String(part.id), structuredClone(part));
    }),
    externalEnginePort: {
      prepareSession: vi.fn(async () => {}),
      async runTurn(
        input: Parameters<NonNullable<AgentRuntimeInternal["externalEnginePort"]>["runTurn"]>[0],
      ) {
        await input.onSession("external-example");
        await input.onConfigOptions([]);
        for (const update of updates) await input.onUpdate(update);
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } };
      },
    },
  } as unknown as AgentRuntimeInternal;
  const traceContext = createRootTraceContext();
  const turnId = createTurnId();
  return {
    parts,
    events,
    runtime,
    input: {
      input: "example",
      attachments: [],
      turnId,
      userMessageId: createMessageId(),
      traceContext,
      signal: new AbortController().signal,
      events: [],
      turnMachine: TurnMachineImpl.create(
        runtime.sessionId,
        0,
        "example",
        traceContext.traceId,
        turnId,
      ),
    },
  };
}
