import { describe, expect, it } from "vitest";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  statePatchSchema,
  turnActivityStateSchema,
  type ConversationSnapshot,
} from "../src/zcode-protocol-v4/index.js";
import { turnActivityStateSchema as legacyEntryTurnActivityStateSchema } from "../src/zcode-protocol/index.js";

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "guard.manualCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "guard.sendQueuedNowStopsBeforeDrain" },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.stopPausesActiveGoalTarget" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: ["medium"],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: { usedTokens: 100, maxTokens: 200000, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const runningTool = {
  turnId: "turn-1",
  lastActivityAt: 5_000,
  phaseStartedAt: 4_000,
  activityPhase: { kind: "running_tool", toolName: "Bash", toolCallId: "call-1" },
} as const;

describe("zcode-protocol-v4 turnActivity", () => {
  it("round-trips a running-tool activity in the snapshot", () => {
    const snapshot = { ...makeSnapshot(), turnActivity: runningTool };
    const parsed = conversationSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.turnActivity).toEqual(runningTool);
  });

  it("keeps legacy snapshots without turnActivity parseable", () => {
    const parsed = conversationSnapshotSchema.parse(makeSnapshot());
    expect(parsed.turnActivity ?? null).toBeNull();
  });

  it("validates phase fields strictly", () => {
    expect(
      turnActivityStateSchema.safeParse({
        ...runningTool,
        activityPhase: { kind: "running_tool" },
      }).success,
    ).toBe(false);
    expect(
      turnActivityStateSchema.safeParse({
        ...runningTool,
        activityPhase: { kind: "waiting_model", toolName: "Bash" },
      }).success,
    ).toBe(false);
    expect(legacyEntryTurnActivityStateSchema).toBe(turnActivityStateSchema);
  });

  it("degrades unknown future phases to null instead of failing the whole snapshot", () => {
    const parsed = conversationSnapshotSchema.parse({
      ...makeSnapshot(),
      turnActivity: { ...runningTool, activityPhase: { kind: "future_phase" } },
    });
    expect(parsed.turnActivity).toBeNull();
  });

  it("replaces the key wholesale through state.updated and clears with null", () => {
    const patch = statePatchSchema.parse({ turnActivity: runningTool });
    const next = applyConversationDeltas(makeSnapshot(), [{ op: "state.updated", patch }]);
    expect(next.turnActivity).toEqual(runningTool);
    const cleared = applyConversationDeltas(next, [
      { op: "state.updated", patch: statePatchSchema.parse({ turnActivity: null }) },
    ]);
    expect(cleared.turnActivity).toBeNull();
  });
});
