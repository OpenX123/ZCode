/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import type { IServiceAccessor } from "@zcode/services";
import { buildAssistantPreviewCards } from "@/lib/assistantPreviewCards.js";
import type { AssistantMediaRef } from "@zcode/shared/zcode-protocol-v4";

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
  it("同一流式正文追加普通文本与新围栏时保留 Markdown 媒体叶子和 Blob 读取", async () => {
    const image = "https://example.com/shot.png";
    const audio = "./clip.wav";
    const video = "./clip.mp4";
    const prepare = vi.fn(async ({ path }: { path: string }) => ({
      dataBase64: "AQ==",
      mediaType: path.endsWith(".wav") ? "audio/wav" : "video/mp4",
    }));
    const services = { mediaPreviewService: { prepare } } as unknown as IServiceAccessor;
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:audio")
      .mockReturnValueOnce("blob:video");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const initial = `![截图](${image})\n\n[音频](${audio})\n\n[视频](${video})`;
    const response = (body: string) =>
      createElement(
        ServiceProvider,
        { services },
        wrap(
          createElement(MessageResponse, {
            children: body,
            streaming: true,
            theme: "light",
            workspacePath: "/workspace",
          }),
        ),
      );
    const view = render(response(initial));
    await waitFor(() => {
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(image);
      expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio");
      expect(view.container.querySelector("video")?.getAttribute("src")).toBe("blob:video");
    });
    const leaves = ["img", "audio", "video"].map((selector) =>
      view.container.querySelector(selector),
    );
    for (const leaf of leaves) {
      if (leaf instanceof HTMLMediaElement) leaf.currentTime = 0.75;
    }

    view.rerender(response(`${initial}\n\n正文继续。`));
    view.rerender(response(`${initial}\n\n正文继续。\n\n\`\`\`text\nhttps://example.com/new`));
    view.rerender(
      response(`${initial}\n\n正文继续。\n\n\`\`\`text\nhttps://example.com/new\n\`\`\``),
    );
    ["img", "audio", "video"].forEach((selector, index) => {
      const leaf = view.container.querySelector(selector);
      expect(leaf).toBe(leaves[index]);
      if (leaf instanceof HTMLMediaElement) expect(leaf.currentTime).toBe(0.75);
    });
    expect(prepare.mock.calls.map(([value]) => value.path).sort()).toEqual(
      ["/workspace/clip.wav", "/workspace/clip.mp4"].sort(),
    );
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:audio");
    expect(revoke).toHaveBeenCalledWith("blob:video");
  });
  it("1.6.1 普通网页与 localhost URL 不再生成网站卡", () => {
    expect(
      buildAssistantPreviewCards("[成果说明](https://example.com/result)", "/workspace"),
    ).toEqual([]);
    const url = "http://localhost:3000/result?next=(step)&x=1";
    expect(buildAssistantPreviewCards(`\`\`\`text\n${url}\n\`\`\``, "/workspace")).toEqual([]);
    expect(buildAssistantPreviewCards(`访问 ${url}`, "/workspace")).toEqual([]);
  });
  it("1.6.1 单 URL text fence 只保留代码块，下方不再追加链接行", () => {
    const href = "https://example.com/result?q=(a)&x=1";
    render(
      wrap(
        createElement(
          MessageResponse,
          { theme: "light", onOpenExternalUrl: vi.fn() },
          `说明\n\n\`\`\`text\n${href}\n\`\`\``,
        ),
      ),
    );
    expect(document.querySelector('[data-language="text"]')?.textContent).toContain(href);
    expect(screen.queryByRole("button", { name: href })).toBeNull();
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
