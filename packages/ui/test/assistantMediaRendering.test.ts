/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildAssistantPreviewCards } from "@/lib/assistantPreviewCards.js";
import type { AssistantMediaRef, AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import {
  extractConversationDeliverables,
  resolveConversationDeliverableKey,
} from "@/v4/conversation-presentation/index.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

// CodeViewer 正文位于第三方 shadow DOM；这里只观察传入的原文，真实渲染由 E2E 覆盖。
vi.mock("@/components/ui/code-viewer.js", () => ({
  CodeViewer: ({ code }: { code: string }) => createElement("pre", null, code),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const wrap = (child: ReturnType<typeof createElement>) =>
  createElement(
    TooltipProvider,
    null,
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, child),
  );
const ref = (
  mediaType: "audio" | "video",
  source: AssistantMediaRef["source"],
): AssistantMediaRef => ({
  id: mediaType,
  mediaType,
  mimeType: `${mediaType}/${mediaType === "audio" ? "mpeg" : "mp4"}`,
  source,
  name: "成果",
});

describe("UX05 已送达媒体", () => {
  it.each([
    ["image", "image/png", "img"],
    ["audio", "audio/wav", "audio"],
    ["video", "video/mp4", "video"],
  ] as const)(
    "%s 成果前插较早来源不重挂真实叶子、不重读或重置 Blob",
    async (kind, mimeType, selector) => {
      const reader = vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]), mediaType: mimeType });
      const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:original");
      const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const source: AssistantTextRow = {
        rowId: 12,
        turnId: "t",
        createdAt: 1,
        createdAtSeq: 12,
        kind: "assistantText",
        text: "",
        state: "complete",
        media: [
          {
            id: "latest",
            name: "较晚来源",
            mediaType: kind,
            mimeType,
            source: { kind: "artifact", uri: "zcode-artifact://session-a/result" },
          },
        ],
      };
      const context = {
        workspacePath: "/same",
        workspaceIdentity: "ssh:host-a",
        workspaceRemoteSessionId: "r-a",
        sessionId: "session-a",
        logEpoch: "epoch-a",
        theme: "light" as const,
        codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
        readAttachment: reader,
      };
      const renderRow = (row: AssistantTextRow) => {
        const deliverable = extractConversationDeliverables([row])[0]!;
        return wrap(
          createElement(ConversationTurnRow, {
            key: resolveConversationDeliverableKey(deliverable, context, row.turnId),
            row,
            deliverable,
            context,
          }),
        );
      };
      const view = render(renderRow(source));
      await waitFor(() =>
        expect(view.container.querySelector(selector)?.getAttribute("src")).toBe("blob:original"),
      );
      const original = view.container.querySelector(selector)!;
      if (original instanceof HTMLMediaElement) original.currentTime = 0.75;
      view.rerender(
        renderRow({
          ...source,
          rowId: 1,
          createdAtSeq: 1,
          media: [{ ...source.media![0]!, id: "earlier", name: "较早来源" }],
        }),
      );
      await waitFor(() =>
        expect(view.container.querySelector(selector)?.getAttribute("src")).toBe("blob:original"),
      );
      expect(view.container.querySelector('[data-source-row-id="1"]')).not.toBeNull();
      expect(view.container.querySelector('[data-source-row-id="12"]')).toBeNull();
      expect(view.container.querySelector(selector)).toBe(original);
      if (original instanceof HTMLMediaElement) expect(original.currentTime).toBe(0.75);
      else expect(original.getAttribute("alt")).toBe("较早来源");
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith({
        sessionId: "session-a",
        ref: "zcode-artifact://session-a/result",
      });
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
    },
  );
  it.each([
    "target",
    "MIME",
    "mediaType",
    "reader",
    "session",
    "workspacePath",
    "workspaceIdentity",
    "remoteSession",
  ] as const)("媒体 %s 改变仍释放旧 Blob 并按新上下文重读", async (changed) => {
    const reader = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array([1]), mediaType: "audio/mpeg" });
    const nextReader = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array([2]), mediaType: "audio/mpeg" });
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:before")
      .mockReturnValueOnce("blob:after");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const media = ref("audio", { kind: "artifact", uri: "zcode-artifact://session-a/clip" });
    const props: MessageResponseProps = {
      theme: "light",
      media: [media],
      readAttachment: reader,
      sessionId: "session-a",
      workspacePath: "/same",
      workspaceIdentity: "ssh:host-a",
      workspaceRemoteSessionId: "r-a",
    };
    const nextProps: MessageResponseProps = { ...props };
    if (changed === "target")
      nextProps.media = [
        { ...media, source: { kind: "artifact", uri: "zcode-artifact://session-a/other" } },
      ];
    if (changed === "MIME") nextProps.media = [{ ...media, mimeType: "audio/wav" }];
    if (changed === "mediaType")
      nextProps.media = [{ ...media, mediaType: "video", mimeType: "video/mp4" }];
    if (changed === "reader") nextProps.readAttachment = nextReader;
    if (changed === "session") nextProps.sessionId = "session-b";
    if (changed === "workspacePath") nextProps.workspacePath = "/other";
    if (changed === "workspaceIdentity") nextProps.workspaceIdentity = "ssh:host-b";
    if (changed === "remoteSession") nextProps.workspaceRemoteSessionId = "r-b";
    const view = render(wrap(createElement(MessageResponse, props)));
    await waitFor(() =>
      expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:before"),
    );
    const original = view.container.querySelector("audio")!;
    view.rerender(wrap(createElement(MessageResponse, nextProps)));
    const selector = changed === "mediaType" ? "video" : "audio";
    await waitFor(() =>
      expect(view.container.querySelector(selector)?.getAttribute("src")).toBe("blob:after"),
    );
    expect(view.container.querySelector(selector)).not.toBe(original);
    expect(original.isConnected).toBe(false);
    expect(revoke).toHaveBeenCalledWith("blob:before");
    expect(changed === "reader" ? nextReader : reader).toHaveBeenLastCalledWith({
      sessionId: changed === "session" ? "session-b" : "session-a",
      ref:
        changed === "target"
          ? "zcode-artifact://session-a/other"
          : "zcode-artifact://session-a/clip",
    });
    expect(reader).toHaveBeenCalledTimes(changed === "reader" ? 1 : 2);
    expect(nextReader).toHaveBeenCalledTimes(changed === "reader" ? 1 : 0);
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:after");
  });
  it("类型化成果每个excerpt只渲染当前媒体，并保留准确来源和上下文按钮", () => {
    const source = {
      rowId: 12,
      turnId: "t",
      createdAt: 1,
      createdAtSeq: 12,
      kind: "assistantText" as const,
      text: "",
      state: "complete" as const,
      media: [
        ref("audio", { kind: "url", url: "https://example.com/audio" }),
        ref("video", { kind: "url", url: "https://example.com/video" }),
      ],
      actions: { canRetry: true, canFork: true },
    };
    const showSource = vi.fn();
    const references = extractConversationDeliverables([source]);
    render(
      wrap(
        createElement(
          "div",
          null,
          references.map((deliverable) =>
            createElement(ConversationTurnRow, {
              key: deliverable.key,
              row: source,
              deliverable,
              context: {
                workspacePath: "/same",
                theme: "light",
                codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
              },
              onShowSourceContext: showSource,
            }),
          ),
        ),
      ),
    );
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(document.querySelectorAll('[data-source-row-id="12"]')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "查看原始上下文" })[0]!);
    expect(showSource).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid^="v4-retry"], [data-testid^="v4-fork"]'),
    ).toBeNull();
  });
  it("Markdown 媒体写法按音视频扩展名复用原生控件", () => {
    render(
      wrap(
        createElement(
          MessageResponse,
          { theme: "light" },
          "![音频](https://example.com/a.wav)\n\n![视频](https://example.com/v.mp4)",
        ),
      ),
    );
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("https://example.com/a.wav");
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://example.com/v.mp4");
  });
  it("无 MIME 的普通网页按收到的标题成卡且手机仍可打开", () => {
    const cards = buildAssistantPreviewCards(
      "[成果说明](https://example.com/result)",
      "/workspace",
      { suppressWebRemoteCards: true },
    );
    expect(cards).toContainEqual(
      expect.objectContaining({
        type: "website",
        title: "成果说明",
        url: "https://example.com/result",
      }),
    );
  });
  it("完整闭合的 localhost URL 不再派生一张截断卡片", () => {
    const url = "http://localhost:3000/result?next=(step)&x=1";
    expect(buildAssistantPreviewCards(`\`\`\`text\n${url}\n\`\`\``, "/workspace")).toEqual([
      expect.objectContaining({ type: "website", url }),
    ]);
  });
  it("最终正文保留单 URL text fence 并可打开完整目标", () => {
    const href = "https://example.com/result?q=(a)&x=1";
    const open = vi.fn();
    render(
      wrap(
        createElement(
          MessageResponse,
          { theme: "light", onOpenExternalUrl: open },
          `说明\n\n\`\`\`text\n${href}\n\`\`\``,
        ),
      ),
    );
    const button = screen.getByRole("button", { name: href });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(href);
    expect(document.querySelector('[data-language="text"]')?.textContent).toContain(href);
  });
  it.each(["audio", "video"] as const)(
    "显式 MIME 的无扩展名 %s 使用原生控件且不自动播放",
    (kind) => {
      render(
        wrap(
          createElement(MessageResponse, {
            theme: "light",
            media: [ref(kind, { kind: "url", url: "https://example.com/download?id=1" })],
          }),
        ),
      );
      const player = document.querySelector(kind);
      expect(player?.getAttribute("src")).toBe("https://example.com/download?id=1");
      expect(player?.hasAttribute("controls")).toBe(true);
      expect(player?.hasAttribute("autoplay")).toBe(false);
    },
  );
  it("媒体 404 保留原始链接且重试只重读资源", () => {
    const url = "https://example.com/audio.mp3";
    const open = vi.fn();
    render(
      wrap(
        createElement(MessageResponse, {
          theme: "light",
          media: [ref("audio", { kind: "url", url })],
          onOpenExternalUrl: open,
        }),
      ),
    );
    fireEvent.error(document.querySelector("audio")!);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: url }));
    expect(open).toHaveBeenCalledWith(url);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(document.querySelector("audio")?.getAttribute("src")).toBe(url);
  });
  it("artifact 经当前会话 reader 读取，卸载重挂与切换 reader 重新授权并释放 URL", async () => {
    const uri = "zcode-artifact://session-a/clip";
    const a = vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]), mediaType: "audio/mpeg" });
    const b = vi.fn().mockResolvedValue({ bytes: new Uint8Array([2]), mediaType: "audio/mpeg" });
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:a").mockReturnValueOnce("blob:b");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const media = [ref("audio", { kind: "artifact", uri })];
    const view = render(
      wrap(
        createElement(MessageResponse, {
          theme: "light",
          media,
          sessionId: "session-a",
          readAttachment: a,
        }),
      ),
    );
    await waitFor(() =>
      expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:a"),
    );
    view.rerender(
      wrap(
        createElement(MessageResponse, {
          theme: "light",
          media,
          sessionId: "session-b",
          readAttachment: b,
        }),
      ),
    );
    await waitFor(() =>
      expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:b"),
    );
    expect(a).toHaveBeenCalledWith({ sessionId: "session-a", ref: uri });
    expect(b).toHaveBeenCalledWith({ sessionId: "session-b", ref: uri });
    expect(revoke).toHaveBeenCalledWith("blob:a");
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:b");
  });
  it("Markdown 图片失效保留来源与重试", () => {
    const src = "https://example.com/missing.png";
    render(wrap(createElement(MarkdownImage, { src, alt: "图片" })));
    fireEvent.error(screen.getByRole("img", { name: "图片" }));
    expect(screen.getByText(src)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByRole("img", { name: "图片" }).getAttribute("src")).toBe(src);
  });
  it("失效artifact保留原引用，重试只重新调用当前会话reader", async () => {
    const uri = "zcode-artifact://session-a/unavailable";
    const reader = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), mediaType: "audio/mpeg" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(
      wrap(
        createElement(MessageResponse, {
          theme: "light",
          media: [ref("audio", { kind: "artifact", uri })],
          sessionId: "session-a",
          readAttachment: reader,
        }),
      ),
    );
    await screen.findByRole("alert");
    expect(screen.getByText(uri)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:recovered"),
    );
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
