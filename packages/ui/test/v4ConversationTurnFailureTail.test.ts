import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/v4/ConversationRowView.js", async () => {
  const React = await import("react");
  return {
    ConversationAssistantTextActions: () => React.createElement("div"),
    ConversationRowView: (props: { row: ConversationRow }) =>
      React.createElement("div", { "data-testid": `row-${props.row.rowId}` }),
  };
});

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
  onResendFailedTurn: vi.fn(async () => {}),
};

const base = { turnId: "turn-1", createdAtSeq: 0, createdAt: 1_700_000_000_000 };

function header(): TurnHeaderRow {
  return {
    ...base,
    rowId: 1,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "failed",
    startedAt: base.createdAt,
    endedAt: base.createdAt + 10,
    failure: {
      code: "external_engine.provider",
      summary: "unexpected status 502 Bad Gateway: Bad gateway",
      source: "provider",
      httpStatus: 502,
      url: "https://gateway.example.test/v1/responses",
      requestId: "fixture-request",
    },
  };
}

function userInput(attachments = false): UserInputRow {
  return {
    ...base,
    rowId: 2,
    createdAtSeq: 1,
    kind: "userInput",
    origin: "realUser",
    text: "检查网关",
    ...(attachments
      ? {
          attachments: [
            { kind: "image", attachmentId: "a1", mime: "image/png", name: "a.png", bytes: 1 },
          ],
        }
      : {}),
  } as UserInputRow;
}

function assistantText(): AssistantTextRow {
  return {
    ...base,
    rowId: 3,
    createdAtSeq: 2,
    kind: "assistantText",
    text: "部分输出",
    state: "interrupted",
  } as AssistantTextRow;
}

function render(rows: ConversationRow[]): string {
  const unit = buildConversationTurnRenderUnits(rows, { sessionPhase: "error" })[0]!;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(ConversationTurnGroup, { unit, context }),
    }),
  );
}

describe("失败轮末尾的行内错误行", () => {
  it("显示失败摘要与 HTTP 状态；没有输出与工具执行的最新失败轮提供重新发送", () => {
    const html = render([header(), userInput()]);
    expect(html).toContain('data-testid="turn-failure-row"');
    expect(html).toContain("unexpected status 502 Bad Gateway: Bad gateway");
    expect(html).toContain("HTTP 502");
    expect(html).toContain("https://gateway.example.test/v1/responses");
    expect(html).toContain('data-testid="turn-failure-resend"');
  });

  it("已有助手输出或原始输入带附件时不提供重新发送", () => {
    expect(render([header(), userInput(), assistantText()])).not.toContain(
      'data-testid="turn-failure-resend"',
    );
    expect(render([header(), userInput(true)])).not.toContain('data-testid="turn-failure-resend"');
  });

  it("旧快照的失败轮缺少 failure 时不渲染行内错误行", () => {
    const legacy = { ...header() };
    delete legacy.failure;
    expect(render([legacy, userInput()])).not.toContain('data-testid="turn-failure-row"');
  });
});
