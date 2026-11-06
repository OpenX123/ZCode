import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ElicitationDialog } from "@/ElicitationDialog.js";
import type { NativePlanApprovalCard } from "@/v4/NativePlanApprovalCard.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";

type ElicitationDialogProps = ComponentProps<typeof ElicitationDialog>;

const captured = vi.hoisted(() => ({
  elicitationProps: null as ElicitationDialogProps | null,
  nativePlanProps: null as ComponentProps<typeof NativePlanApprovalCard> | null,
  sendCommand: vi.fn(),
}));

vi.mock("@/v4/NativePlanApprovalCard.js", async () => {
  const React = await import("react");
  return {
    NativePlanApprovalCard: (props: ComponentProps<typeof NativePlanApprovalCard>) => {
      captured.nativePlanProps = props;
      return React.createElement("div", { "data-testid": "mock-native-plan" });
    },
  };
});

vi.mock("@/ElicitationDialog.js", async () => {
  const React = await import("react");
  return {
    ElicitationDialog: (props: ElicitationDialogProps) => {
      captured.elicitationProps = props;
      return React.createElement("div", { "data-testid": "mock-elicitation" });
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    sendCommand: captured.sendCommand,
  }),
}));

vi.mock("@/hooks/useTaskNotifications.js", () => ({
  usePendingInteractionTaskNotifications: () => {},
}));

function makePlanSnapshot(): ConversationSnapshot {
  return {
    sessionId: "session-plan",
    pendingInteractions: [
      {
        interactionId: "plan-request-1",
        kind: "userInput",
        anchorRowId: 5,
        createdAt: 300,
        payload: {
          kind: "userInput",
          prompt: "Review this implementation plan.",
          freeText: true,
          toolName: "ExitPlanMode",
          toolCallId: "exit-plan-1",
          traceId: "trace-plan",
          schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
          questions: [
            {
              question: "Review this implementation plan.",
              header: "Plan",
              options: [{ value: "approve", label: "Approve" }],
            },
          ],
        },
      },
    ],
  } as ConversationSnapshot;
}

function makeAskUserSnapshot(): ConversationSnapshot {
  const snapshot = makePlanSnapshot();
  const pending = snapshot.pendingInteractions[0];
  if (!pending || pending.payload.kind !== "userInput") return snapshot;
  return {
    ...snapshot,
    pendingInteractions: [
      {
        ...pending,
        interactionId: "ask-request-1",
        payload: {
          ...pending.payload,
          toolName: "AskUserQuestion",
          toolCallId: "ask-user-1",
          schema: { toolName: "AskUserQuestion" },
        },
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  captured.elicitationProps = null;
  captured.nativePlanProps = null;
  vi.clearAllMocks();
});

it.each([true, false])("原生计划start=%s只提交既有交互回执，不另发实施输入", async (start) => {
  captured.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => ({
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  }));
  const snapshot = makePlanSnapshot();
  const interaction = snapshot.pendingInteractions[0]!;
  if (interaction.payload.kind === "userInput") interaction.payload.input = { plan: "# 原生计划" };
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4InteractionDialogs, {
        sessionId: "session-plan",
        workspacePath: "/workspace",
        snapshot,
      }),
    ),
  );
  expect(captured.nativePlanProps?.markdown).toBe("# 原生计划");
  await captured.nativePlanProps?.onResolve(start);
  expect(captured.sendCommand).toHaveBeenCalledTimes(1);
  expect(captured.sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "resolveInteraction",
      payload: {
        interactionId: "plan-request-1",
        answer: start ? { optionId: "allowOnce" } : { action: "decline" },
      },
    }),
  );
});

describe("V4 mobile plan interaction acknowledgement", () => {
  it("reports an accepted ExitPlanMode response to the owning pane", async () => {
    captured.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    const onPlanInteractionAccepted = vi.fn();

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "session-plan",
          workspacePath: "/workspace",
          snapshot: makePlanSnapshot(),
          onPlanInteractionAccepted,
        }),
      ),
    );

    expect(captured.elicitationProps).not.toBeNull();
    captured.elicitationProps?.onRespond("plan-request-1", "accept", {
      answer: "approve",
    });
    await flushMicrotasks();

    expect(onPlanInteractionAccepted).toHaveBeenCalledTimes(1);
    expect(onPlanInteractionAccepted).toHaveBeenCalledWith("plan-request-1");
  });

  it.each(["duplicate", "noop"] as const)(
    "reports a %s ExitPlanMode response for authoritative reconciliation",
    async (status) => {
      captured.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => ({
        commandId: envelope.commandId,
        revisionAtDecision: 1,
        status,
      }));
      const onPlanInteractionAccepted = vi.fn();

      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(V4InteractionDialogs, {
            sessionId: "session-plan",
            workspacePath: "/workspace",
            snapshot: makePlanSnapshot(),
            onPlanInteractionAccepted,
          }),
        ),
      );
      captured.elicitationProps?.onRespond("plan-request-1", "accept", {
        answer: "approve",
      });
      await flushMicrotasks();

      expect(onPlanInteractionAccepted).toHaveBeenCalledWith("plan-request-1");
    },
  );

  it("does not report rejected ExitPlanMode responses", async () => {
    captured.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => ({
      commandId: envelope.commandId,
      reasonCode: "guard.interactionRejected",
      revisionAtDecision: 1,
      status: "rejected" as const,
    }));
    const onPlanInteractionAccepted = vi.fn();

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "session-plan",
          workspacePath: "/workspace",
          snapshot: makePlanSnapshot(),
          onPlanInteractionAccepted,
        }),
      ),
    );
    captured.elicitationProps?.onRespond("plan-request-1", "accept", {
      answer: "approve",
    });
    await flushMicrotasks();

    expect(onPlanInteractionAccepted).not.toHaveBeenCalled();
  });

  it("does not report accepted AskUserQuestion responses as plan interactions", async () => {
    captured.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    const onPlanInteractionAccepted = vi.fn();

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "session-plan",
          workspacePath: "/workspace",
          snapshot: makeAskUserSnapshot(),
          onPlanInteractionAccepted,
        }),
      ),
    );
    captured.elicitationProps?.onRespond("ask-request-1", "accept", {
      answer: "safe",
    });
    await flushMicrotasks();

    expect(onPlanInteractionAccepted).not.toHaveBeenCalled();
  });
});
