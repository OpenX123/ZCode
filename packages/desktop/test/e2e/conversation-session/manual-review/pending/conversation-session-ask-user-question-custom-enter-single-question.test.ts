import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_TOOL_SUMMARY_TRIGGER,
} from "@zcode/shared/test-ids";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { confirmAskUserQuestionCustomAnswerByKeyboard } from "../../../helpers/conversation-session-tool.js";
import {
  waitForUpstreamRequest,
  waitForToolCallBlockByToolName,
} from "../../../helpers/conversation-session.js";

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_CUSTOM_ENTER_SINGLE";
const TOOL_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SINGLE_TOOL";
const QUESTION_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SINGLE_QUESTION";
const ANSWER_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SINGLE_ANSWER";

describe("会话区 AskUserQuestion 单题 custom input Enter E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("只有一题时 custom input Enter 不提交，显式发送才提交", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${TOOL_MARKER}: ask one question before continuing.`,
      `${QUESTION_MARKER}: include this marker in the question text.`,
      "The custom answer is edited in the input and explicitly sent using the confirmation button.",
      "After the user answers, continue with a brief acknowledgement.",
    ].join(" ");
    const answer = `${ANSWER_MARKER}_${runId}`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "AskUserQuestion 单题首发后输入框没有清空");
    await waitForV4TimelineContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationDialogContaining(QUESTION_MARKER);
    // 单题输入 Enter 仍是编辑；Tab 到明确发送动作才提交。
    await editThenConfirmCustomAnswer(answer);

    await waitForUpstreamRequest(
      {
        includes: [answer, TOOL_MARKER],
      },
      "AskUserQuestion 单题自定义回答按 Enter 后没有进入下一次模型请求",
      60000,
    );

    await waitForExpandedAskUserQuestionBlockContaining(answer, 8000);
  });
});

async function editThenConfirmCustomAnswer(answer: string) {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  await input.click();
  await input.setValue(answer);
  await browser.waitUntil(async () => (await input.getValue()) === answer, {
    timeout: 10000,
    timeoutMsg: "AskUserQuestion 自定义回答没有写入输入框",
  });
  await confirmAskUserQuestionCustomAnswerByKeyboard(answer);
}

async function waitForElicitationDialogContaining(text: string, timeout = 60000) {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationDialogText();
        return latest.includes(text);
      },
      {
        timeout,
        timeoutMsg: `AskUserQuestion 问答卡片没有显示预期内容: ${text}`,
      },
    );
  } catch (error) {
    latest = await getElicitationDialogText();
    throw new Error(`AskUserQuestion 问答卡片没有显示预期内容: ${text}; latest=${latest}`, {
      cause: error,
    });
  }
}

function getElicitationDialogText() {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    return normalizeText(
      document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]')?.innerText,
    );
  });
}

async function waitForExpandedAskUserQuestionBlockContaining(text: string, timeout: number) {
  let latest: AskUserQuestionBlockDiagnostics | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getExpandedAskUserQuestionBlockDiagnostics(text);
        return latest.matched;
      },
      {
        timeout,
        timeoutMsg: "AskUserQuestion 自定义回答没有显示在已询问消息详情里",
      },
    );
  } catch (error) {
    latest = await getExpandedAskUserQuestionBlockDiagnostics(text);
    throw new Error(
      `AskUserQuestion 自定义回答没有显示在已询问消息详情里; diagnostics=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

interface AskUserQuestionBlockDiagnostics {
  blocks: Array<{
    expanded: boolean;
    text: string;
    toolCallId: string | null;
  }>;
  matched: boolean;
}

function getExpandedAskUserQuestionBlockDiagnostics(
  text: string,
): Promise<AskUserQuestionBlockDiagnostics> {
  return browser.execute(
    (historyTriggerPrefix, toolBlockPrefix, summaryTriggerPrefix, expectedText) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const historyTriggers = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${historyTriggerPrefix}-"]`),
      );
      for (const trigger of historyTriggers) {
        if (
          trigger.getAttribute("data-history-has-content") !== "false" &&
          trigger.getAttribute("aria-expanded") !== "true"
        ) {
          trigger.click();
        }
      }

      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${toolBlockPrefix}-"][data-tool-name="AskUserQuestion"]`,
        ),
      );

      for (const block of blocks) {
        const trigger = block.querySelector<HTMLElement>(
          `[data-testid^="${summaryTriggerPrefix}-"]`,
        );
        if (trigger && trigger.getAttribute("aria-expanded") !== "true") {
          trigger.click();
        }
      }

      const snapshots = blocks.map((block) => {
        const trigger = block.querySelector<HTMLElement>(
          `[data-testid^="${summaryTriggerPrefix}-"]`,
        );
        return {
          expanded: trigger?.getAttribute("aria-expanded") === "true",
          text: normalizeText(block.innerText),
          toolCallId: block.getAttribute("data-tool-call-id"),
        };
      });

      return {
        blocks: snapshots,
        matched: snapshots.some((block) => block.text.includes(expectedText)),
      };
    },
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_TOOL_CALL_BLOCK,
    TID_TOOL_SUMMARY_TRIGGER,
    text,
  );
}
