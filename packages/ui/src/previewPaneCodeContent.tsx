import type { BundledLanguage, BundledTheme } from "shiki";
import { useEffect, useState, type Ref, type UIEventHandler } from "react";
import type { FileMediaPreview } from "@zcode/shared";
import { toFileUrl } from "@/lib/path.js";
import { parseAssistantFileUrlPath } from "@/lib/assistantFileReferences.js";
import { cn } from "@/components/lib/utils.js";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block.js";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import type { CodeCommentLabels } from "@/components/ui/code-viewer.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import { isMermaidLanguage } from "@/lib/mermaidLanguage.js";
import type { Theme } from "@/useTheme.js";

interface CodeContentProps {
  code: string;
  language: BundledLanguage;
  codePreviewSettings: CodePreviewSettings;
  codeTheme: BundledTheme;
  /** 应用主题（store 耦合剥离）：透传给 Mermaid 预览，缺省按 "system" 兜底。 */
  theme?: Theme;
  wrapLongLines: boolean;
  firstLineNumber?: number;
  comments?: readonly CodeCommentPreview[];
  topComment?: CodeCommentPreview | null;
  topCommentShowRange?: boolean;
  topCommentNotice?: string;
  focusedRange?: CodeCommentRange | null;
  focusRequestId?: string;
  enableLineSelection?: boolean;
  enableGutterUtility?: boolean;
  labels?: Partial<CodeCommentLabels>;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
  className?: string;
}

export type HtmlPreviewResourceReader = (path: string) => Promise<FileMediaPreview>;

export async function prepareHtmlPreviewDocument(
  content: string,
  path: string,
  readResource: HtmlPreviewResourceReader,
): Promise<string> {
  const document = new DOMParser().parseFromString(content, "text/html");
  const fileUrl = toFileUrl(path);
  const base = new URL(document.querySelector("base[href]")?.getAttribute("href") ?? "", fileUrl);
  document.querySelectorAll("base").forEach((node) => node.remove());
  const baseNode = document.createElement("base");
  baseNode.href = base.href;
  document.head.prepend(baseNode);
  const resources = new Map<string, Promise<FileMediaPreview>>();
  const resourceUrl = async (
    value: string,
    owner: string,
    ancestors: string[] = [],
  ): Promise<string> => {
    if (!value || value.startsWith("#") || value.startsWith("data:")) return value;
    let url: URL;
    try {
      url = new URL(value, owner);
    } catch {
      return value;
    }
    if (url.protocol !== "file:") return url.href;
    const resourcePath = parseAssistantFileUrlPath(url.href);
    if (!resourcePath || ancestors.includes(url.href)) return url.href;
    try {
      let resource = resources.get(resourcePath);
      if (!resource) {
        if (resources.size >= 64) return url.href;
        resource = readResource(resourcePath);
        resources.set(resourcePath, resource);
      }
      const preview = await resource;
      if (url.pathname.toLowerCase().endsWith(".css")) {
        const css = new TextDecoder().decode(
          Uint8Array.from(atob(preview.dataBase64), (character) => character.charCodeAt(0)),
        );
        const rewritten = await rewriteCss(css, url.href, [...ancestors, url.href]);
        const encoded = Array.from(new TextEncoder().encode(rewritten), (byte) =>
          String.fromCharCode(byte),
        ).join("");
        return `data:text/css;base64,${btoa(encoded)}`;
      }
      return `data:${preview.mediaType};base64,${preview.dataBase64}${url.hash}`;
    } catch {
      // 单个缺失资源不能让正文消失，也不能退回 Renderer 目录读取同名文件。
      return url.href;
    }
  };
  async function rewriteCss(css: string, owner: string, ancestors: string[] = []): Promise<string> {
    const pattern =
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
    const matches = [...css.matchAll(pattern)];
    const replacements = await Promise.all(
      matches.map(async (match) => {
        const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
        const url = (await resourceUrl(value, owner, ancestors)).replace(/"/g, "%22");
        return match[0].toLowerCase().startsWith("@import") ? `@import "${url}"` : `url("${url}")`;
      }),
    );
    for (let index = matches.length - 1; index >= 0; index--) {
      const match = matches[index]!;
      css =
        css.slice(0, match.index) + replacements[index] + css.slice(match.index + match[0].length);
    }
    return css;
  }
  // srcdoc 的缺省 base 是应用页面；所有文件资源必须经来源 workspace 读取，兼容 SSH 与 Web。
  await Promise.all([
    ...Array.from(
      document.querySelectorAll(
        "link[rel~='stylesheet'][href], img[src], source[src], video[poster]",
      ),
      async (node) => {
        const attribute =
          node.tagName === "LINK" ? "href" : node.tagName === "VIDEO" ? "poster" : "src";
        node.setAttribute(attribute, await resourceUrl(node.getAttribute(attribute)!, base.href));
      },
    ),
    ...Array.from(document.querySelectorAll("style, [style]"), async (node) => {
      if (node.hasAttribute("style"))
        node.setAttribute("style", await rewriteCss(node.getAttribute("style")!, base.href));
      if (node.tagName === "STYLE")
        node.textContent = await rewriteCss(node.textContent ?? "", base.href);
    }),
  ]);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

export function HtmlPreviewContent({
  title,
  content,
  path,
  readResource,
}: {
  title: string;
  content: string;
  path?: string;
  readResource?: HtmlPreviewResourceReader;
}) {
  const [prepared, setPrepared] = useState<{
    content: string;
    path: string;
    readResource: HtmlPreviewResourceReader;
    html: string;
  }>();
  useEffect(() => {
    let disposed = false;
    if (path && readResource)
      void prepareHtmlPreviewDocument(content, path, readResource)
        .then((html) => {
          if (!disposed) setPrepared({ content, path, readResource, html });
        })
        .catch(() => {
          if (!disposed) setPrepared({ content, path, readResource, html: content });
        });
    return () => {
      disposed = true;
    };
  }, [content, path, readResource]);
  const preparedForSource =
    prepared?.content === content &&
    prepared.path === path &&
    prepared.readResource === readResource;
  // 资源准备完成后才挂载 iframe，避免空文档与正式 srcdoc 换代时丢失 frame 上下文。
  if (path && readResource && !preparedForSource) return <div className="h-full bg-white" />;
  const html = preparedForSource ? prepared.html : content;
  return (
    <iframe
      className="h-full w-full border-0 bg-white"
      data-testid="html-file-preview"
      title={title}
      // 业务模板会在缺少登录状态时跳到 /login；静态预览禁止脚本和自动刷新，保留原页面。
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={html}
    />
  );
}

export function CodeContent({
  code,
  language,
  codePreviewSettings,
  codeTheme,
  theme,
  wrapLongLines,
  firstLineNumber,
  comments,
  topComment,
  topCommentShowRange,
  topCommentNotice,
  focusedRange,
  focusRequestId,
  enableLineSelection = false,
  enableGutterUtility = false,
  labels,
  onSubmitCodeComment,
  onDeleteCodeComment,
  onScroll,
  scrollContainerRef,
  className,
}: CodeContentProps) {
  if (isMermaidLanguage(language)) {
    return (
      <div
        ref={scrollContainerRef}
        className={cn("h-full w-full overflow-auto bg-background p-4", className)}
        onScroll={onScroll}
      >
        <MermaidBlock
          code={code}
          theme={theme}
          className="min-h-full rounded-xl border border-border"
        />
      </div>
    );
  }

  return (
    <CodeViewer
      code={code}
      language={language}
      showLineNumbers={codePreviewSettings.showLineNumbers}
      theme={codeTheme}
      wrapLongLines={wrapLongLines}
      fontSizePx={codePreviewSettings.fontSizePx}
      firstLineNumber={firstLineNumber}
      comments={comments}
      topComment={topComment}
      topCommentShowRange={topCommentShowRange}
      topCommentNotice={topCommentNotice}
      focusedRange={focusedRange}
      focusRequestId={focusRequestId}
      enableLineSelection={enableLineSelection}
      enableGutterUtility={enableGutterUtility}
      labels={labels}
      onSubmitCodeComment={onSubmitCodeComment}
      onDeleteCodeComment={onDeleteCodeComment}
      onScroll={onScroll}
      scrollContainerRef={scrollContainerRef}
      className={className}
    />
  );
}
