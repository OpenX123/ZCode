import { describe, expect, it } from "vitest";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { extractConversationDeliverables } from "@/v4/conversation-presentation/index.js";
import { buildConversationFlowItems } from "@/v4/conversationTurnFlowItems.js";

function row(
  text: string,
  state: AssistantTextRow["state"] = "complete",
  rowId = 12,
): AssistantTextRow {
  return {
    rowId,
    turnId: "t",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "assistantText",
    state,
    text,
  };
}

describe("1.6.1 移除成果摘录", () => {
  it("历史中的链接、text fence 与类型化媒体不再复制为额外行，flow 只按原行序输出", () => {
    const source = {
      ...row(
        "请打开：\n\nhttps://example.invalid/login\n\n```text\nhttps://example.invalid/b\n```\n",
      ),
      media: [
        {
          id: "audio-1",
          mediaType: "audio" as const,
          mimeType: "audio/wav",
          source: { kind: "url" as const, url: "https://example.invalid/a.wav" },
        },
      ],
    };
    const streaming = row("正在输出", "streaming", 20);
    const items = buildConversationFlowItems({
      orderedRows: [source, streaming],
      assistantHistoryRows: [source],
      assistantFollowingRows: [],
      assistantTailRows: [],
      latestAssistantTextRow: streaming,
      visibleAssistantTextRow: streaming,
      timelineOnly: false,
    });
    expect(items).toEqual([
      { kind: "assistantHistory", rows: [source] },
      { kind: "assistantText", row: streaming, latest: true },
    ]);
  });
});

describe("正文引用提取（供媒体内嵌）", () => {
  it("独立 URL 保留授权参数和准确来源区间", () => {
    const source = row(
      "请打开以下入口完成操作：\n\nhttps://example.invalid/authorize?code=fixture&next=%2Fdone\n",
    );
    const [reference] = extractConversationDeliverables([source]);
    expect(reference).toMatchObject({
      sourceRowId: 12,
      kind: "link",
      sourceFormat: "standaloneUrl",
      target: "https://example.invalid/authorize?code=fixture&next=%2Fdone",
    });
    expect(source.text.slice(reference!.start, reference!.end)).toBe(reference!.target);
  });

  it.each(["complete", "streaming", "interrupted", "failed"] as const)(
    "%s 行已闭合 Markdown/图片均可引用",
    (state) => {
      const references = extractConversationDeliverables([
        row(
          "打开 [授权](https://example.invalid/login)。\n\n![二维码](https://example.invalid/qr.png)",
          state,
        ),
      ]);
      expect(references.map(({ kind, target }) => [kind, target])).toEqual([
        ["link", "https://example.invalid/login"],
        ["image", "https://example.invalid/qr.png"],
      ]);
    },
  );

  it("接纳中文、空格、引号和括号文件目标，不读取 Host 或预造媒体事实", () => {
    const references = extractConversationDeliverables([
      row(
        '[报告]("C:/工作 区/年度 总结.pdf")\n\n[数据](输出/数据 (终稿).xlsx)\n\n[视频](https://example.invalid/demo.mp4)',
      ),
    ]);
    expect(references.map(({ kind, target }) => [kind, target])).toEqual([
      ["file", "C:/工作 区/年度 总结.pdf"],
      ["file", "输出/数据 (终稿).xlsx"],
      ["link", "https://example.invalid/demo.mp4"],
    ]);
  });

  it.each([
    "curl https://example.invalid/login",
    "执行 `https://example.invalid/login`",
    "    https://example.invalid/login\n",
    "```sh\ncurl https://example.invalid/login\n```",
    "```js\n[示例](https://example.invalid/login)\n```",
    "```text\nhttps://example.invalid/login\n```",
    "```text\nhttps://example.invalid/login",
    "[入口](https://example.invalid/login",
    "![图](https://example.invalid/qr.png",
    "[入口](javascript:alert(1))",
    '[入口]("输出/未闭合.pdf)',
  ])("不提升代码/命令/text fence/未闭合/无效目标 %j", (text) => {
    expect(extractConversationDeliverables([row(text, "streaming")])).toEqual([]);
  });

  it("流式独立 URL 以换行确认完整；终止后允许最后一行", () => {
    expect(
      extractConversationDeliverables([row("https://example.invalid/login?c=par", "streaming")]),
    ).toEqual([]);
    expect(
      extractConversationDeliverables([row("https://example.invalid/login\n", "streaming")]),
    ).toHaveLength(1);
    expect(
      extractConversationDeliverables([row("https://example.invalid/login", "failed")]),
    ).toHaveLength(1);
    expect(
      extractConversationDeliverables([row("https://example.invalid/login  ", "streaming")]),
    ).toEqual([]);
  });

  it("跨行 inline code 不提升", () => {
    expect(
      extractConversationDeliverables([row("`示例\n[入口](https://example.invalid/login)\n`\n")]),
    ).toEqual([]);
  });

  it("秒表刷新和相同内容重建行不会重复解析，前插历史与状态终止不改来源 key", () => {
    const source = row("[入口](https://example.invalid/a)", "streaming");
    const first = extractConversationDeliverables([source])[0];
    expect(extractConversationDeliverables([source])[0]).toBe(first);
    expect(extractConversationDeliverables([row("更早", "complete", 1), source])[0]?.key).toBe(
      first?.key,
    );
    expect(extractConversationDeliverables([{ ...source, state: "failed" }])[0]?.key).toBe(
      first?.key,
    );
  });
});
