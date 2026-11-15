import { describe, expect, it } from "vitest";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import {
  extractConversationDeliverables,
  resolveConversationDeliverableKey,
} from "@/v4/conversation-presentation/index.js";
import {
  buildConversationFlowItems,
  resolveConversationFlowItemKey,
} from "@/v4/conversationTurnFlowItems.js";

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

describe("UX04 source deliverables", () => {
  const audio = {
    id: "audio-1",
    mediaType: "audio" as const,
    mimeType: "audio/wav",
    source: { kind: "url" as const, url: "https://example.invalid/download?id=1" },
    name: "音频成果",
  };
  const image = {
    id: "image-1",
    mediaType: "image" as const,
    mimeType: "image/png",
    source: { kind: "url" as const, url: "https://example.invalid/image" },
    name: "图片成果",
  };
  const mediaFlow = (source: AssistantTextRow, final: AssistantTextRow) =>
    buildConversationFlowItems({
      orderedRows: [source, final],
      assistantHistoryRows: [source],
      assistantFollowingRows: [],
      assistantTailRows: [],
      latestAssistantTextRow: final,
      visibleAssistantTextRow: final,
      timelineOnly: false,
    });

  it("UX05 空正文媒体保留单项原引用，正文缓存不吞掉媒体增量", () => {
    const source = row("", "streaming");
    expect(extractConversationDeliverables([source])).toEqual([]);
    source.media = [audio, image];
    const refs = extractConversationDeliverables([source]);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      sourceFormat: "typedMedia",
      sourceRowId: 12,
      media: audio,
      contextText: "",
      start: 0,
      end: 0,
    });
    expect(refs[1]?.media).toBe(image);
    expect(refs[0]?.key).toContain(audio.id);
  });

  it("UX05 媒体之后的最终摘要不隐藏成果，每项独立且原行不变", () => {
    const source = { ...row("原说明"), media: [audio, image] };
    const final = row("完成", "complete", 20);
    const items = mediaFlow(source, final);
    const refs = items.flatMap((item) =>
      item.kind === "assistantText" && item.deliverable ? [item.deliverable] : [],
    );
    expect(refs.map((ref) => ref.media)).toEqual([audio, image]);
    expect(items[0]).toEqual({ kind: "assistantHistory", rows: [source] });
    expect(source.text).toBe("原说明");
    expect(items.at(-1)).toMatchObject({ row: final, latest: true });
  });

  it("UX05 最终普通同URL链接不吞typed媒体，最终嵌入只逐项覆盖", () => {
    const source = {
      ...row("[网页](https://example.invalid/download?id=1)"),
      media: [audio, image],
    };
    const final = row("[网页](https://example.invalid/download?id=1)", "complete", 20);
    const refs = (target: AssistantTextRow) =>
      mediaFlow(source, target).flatMap((item) =>
        item.kind === "assistantText" && item.deliverable ? [item.deliverable] : [],
      );
    expect(refs(final).map((ref) => ref.media)).toEqual([audio, image]);
    expect(refs({ ...final, media: [audio] }).map((ref) => ref.media)).toEqual([image]);
    expect(refs({ ...final, media: [audio, image] })).toEqual([]);
    expect(
      refs({
        ...final,
        text: `${final.text}\n\n![图片](https://example.invalid/image)`,
        media: [audio],
      }),
    ).toEqual([]);
    const changedMime = { ...audio, mimeType: "audio/mpeg" };
    expect(refs({ ...final, media: [changedMime] }).map((ref) => ref.media)).toEqual([
      audio,
      image,
    ]);
  });

  it("UX05 同目标网页与媒体key区分，来源变化稳定且完整scope隔离", () => {
    const source = { ...row("[网页](https://example.invalid/download?id=1)"), media: [audio] };
    const items = mediaFlow(source, row("完成", "complete", 20)).filter(
      (item) => item.kind === "assistantText" && item.deliverable,
    );
    expect(
      new Set(items.map((item, index) => resolveConversationFlowItemKey(item, index, 0))).size,
    ).toBe(2);
    const reference = extractConversationDeliverables([source]).find((ref) => ref.media)!;
    const earlier = extractConversationDeliverables([
      { ...source, rowId: 1, media: [{ ...audio, id: "earlier" }] },
    ]).find((ref) => ref.media)!;
    const scope = {
      workspacePath: "/same",
      workspaceIdentity: "ssh:a",
      workspaceRemoteSessionId: "r",
      sessionId: "s",
      logEpoch: "e",
    };
    const key = resolveConversationDeliverableKey(reference, scope, "t");
    expect(resolveConversationDeliverableKey(earlier, scope, "t")).toBe(key);
    expect(earlier.key).not.toBe(reference.key);
    for (const changed of [
      { workspaceIdentity: "ssh:b" },
      { workspaceRemoteSessionId: "r2" },
      { sessionId: "s2" },
      { logEpoch: "e2" },
    ])
      expect(resolveConversationDeliverableKey(reference, { ...scope, ...changed }, "t")).not.toBe(
        key,
      );
    expect(resolveConversationDeliverableKey(reference, scope, "t2")).not.toBe(key);
  });
  it("保留独立入口完整用途段落、授权参数和准确来源区间", () => {
    const source = row(
      "请打开以下入口完成操作：\n\nhttps://example.invalid/authorize?code=fixture&next=%2Fdone\n",
    );
    const [reference] = extractConversationDeliverables([source]);
    expect(reference).toMatchObject({
      sourceRowId: 12,
      kind: "link",
      target: "https://example.invalid/authorize?code=fixture&next=%2Fdone",
      contextText: source.text.trim(),
    });
    expect(source.text.slice(reference!.start, reference!.end)).toBe(reference!.target);
    expect(source.text.slice(reference!.contextStart, reference!.contextEnd)).toBe(
      reference!.contextText,
    );
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

  it("闭合且仅含一个 URL 的 text fence 保留前置说明", () => {
    const source = row("完成登录后继续：\n\n```text\nhttps://example.invalid/login\n```\n");
    expect(extractConversationDeliverables([source])).toEqual([
      expect.objectContaining({
        target: "https://example.invalid/login",
        sourceFormat: "textFence",
        contextText: source.text.trim(),
      }),
    ]);
  });

  it("text fence 保留括号、查询参数与编码字符的完整目标，不裁切或重建", () => {
    const target =
      "https://example.invalid/login(step)?next=(done)&label=%E4%B8%AD%E6%96%87%20path&angle=%3Cdone%3E";
    expect(
      extractConversationDeliverables([row(`\`\`\`text\n${target}\n\`\`\``)])[0],
    ).toMatchObject({ target, sourceFormat: "textFence" });
    expect(
      extractConversationDeliverables([row("```text\nhttps://example.invalid/a b\n```")]),
    ).toEqual([]);
  });

  it.each([
    "curl https://example.invalid/login",
    "执行 `https://example.invalid/login`",
    "    https://example.invalid/login\n",
    "```sh\ncurl https://example.invalid/login\n```",
    "```js\n[示例](https://example.invalid/login)\n```",
    "```text\nhttps://example.invalid/a\nhttps://example.invalid/b\n```",
    "```text\nhttps://example.invalid/login",
    "[入口](https://example.invalid/login",
    "![图](https://example.invalid/qr.png",
    "[入口](javascript:alert(1))",
    '[入口]("输出/未闭合.pdf)',
  ])("不提升代码/命令/未闭合/无效目标 %j", (text) => {
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

  it("CRLF 段落保留说明，并且跨行 inline code 不提升", () => {
    const source = row("请继续授权：\r\n\r\nhttps://example.invalid/login\r\n");
    expect(extractConversationDeliverables([source])[0]?.contextText).toBe(source.text.trim());
    expect(
      extractConversationDeliverables([row("`示例\n[入口](https://example.invalid/login)\n`\n")]),
    ).toEqual([]);
  });

  it("提取保留原文顺序的全部真实来源，跨来源去重必须晚于完整原段分组", () => {
    const references = extractConversationDeliverables([
      row("[首](https://example.invalid/a) [次](https://example.invalid/b)"),
      row("[重复](https://example.invalid/a)", "complete", 14),
    ]);
    expect(references.map((reference) => reference.target)).toEqual([
      "https://example.invalid/a",
      "https://example.invalid/b",
      "https://example.invalid/a",
    ]);
    expect(references[0]?.sourceRowId).toBe(12);
    expect(references[2]?.sourceRowId).toBe(14);
  });

  it("前插同目标允许真实来源更新，但同 scope/turn 的逻辑挂载身份不变", () => {
    const current = row("当前说明：[入口](https://example.invalid/a)", "complete", 20);
    const earlier = row("更早说明：[入口](https://example.invalid/a)", "complete", 10);
    const before = extractConversationDeliverables([current])[0]!;
    const after = extractConversationDeliverables([earlier, current])[0]!;
    expect(after.sourceRowId).toBe(10);
    expect(after.key).not.toBe(before.key);
    expect(after.contextText).toBe(earlier.text);
    expect(
      resolveConversationDeliverableKey(after, { workspacePath: "/same", sessionId: "s" }, "t"),
    ).toBe(
      resolveConversationDeliverableKey(before, { workspacePath: "/same", sessionId: "s" }, "t"),
    );
  });

  it("完整原始目标组的顺序、重复和来源代表不参与挂载身份，目标集合与scope仍隔离", () => {
    const reference = extractConversationDeliverables([row("[A](https://example.invalid/a)")])[0]!;
    const group = {
      ...reference,
      identityTargets: ["https://example.invalid/a", "https://example.invalid/b"],
    };
    const scope = {
      workspacePath: "/same",
      workspaceIdentity: "ssh:a",
      workspaceRemoteSessionId: "r",
      sessionId: "s",
      logEpoch: "e",
    };
    const key = resolveConversationDeliverableKey(group, scope, "t");
    expect(
      resolveConversationDeliverableKey(
        {
          ...group,
          key: "other-source",
          sourceRowId: 8,
          target: "https://example.invalid/b",
          identityTargets: [
            "https://example.invalid/b",
            "https://example.invalid/a",
            "https://example.invalid/a",
          ],
        },
        scope,
        "t",
      ),
    ).toBe(key);
    expect(
      resolveConversationDeliverableKey(
        { ...group, identityTargets: ["https://example.invalid/a", "https://example.invalid/c"] },
        scope,
        "t",
      ),
    ).not.toBe(key);
    expect(
      resolveConversationDeliverableKey(group, { ...scope, workspaceIdentity: "ssh:b" }, "t"),
    ).not.toBe(key);
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

  it("挂载 key 隔离同路径的不同 Host/session/epoch/turn，identity trim 与本地 fallback 一致", () => {
    const reference = extractConversationDeliverables([row("[入口](报告.pdf)")])[0]!;
    const scope = {
      workspacePath: "/same",
      workspaceIdentity: " ssh:a ",
      workspaceRemoteSessionId: "r1",
      sessionId: "s1",
      logEpoch: "e1",
    };
    const key = resolveConversationDeliverableKey(reference, scope, "turn");
    for (const changed of [
      { workspaceIdentity: "ssh:b" },
      { workspaceRemoteSessionId: "r2" },
      { sessionId: "s2" },
      { logEpoch: "e2" },
    ])
      expect(
        resolveConversationDeliverableKey(reference, { ...scope, ...changed }, "turn"),
      ).not.toBe(key);
    expect(resolveConversationDeliverableKey(reference, scope, "other")).not.toBe(key);
    expect(
      resolveConversationDeliverableKey(
        reference,
        { ...scope, workspaceIdentity: "ssh:a" },
        "turn",
      ),
    ).toBe(key);
    expect(resolveConversationDeliverableKey(reference, { workspacePath: "/same" }, "turn")).toBe(
      resolveConversationDeliverableKey(
        reference,
        { workspacePath: "/same", workspaceIdentity: " " },
        "turn",
      ),
    );
  });
});
