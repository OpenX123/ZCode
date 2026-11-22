import { parseSessionDeepLink } from "@zcode/shared/session-navigation";
import { getPathLeaf } from "@/lib/path.js";
import type {
  ParseTaskTitleDisplayOptions,
  TaskTitleFallbackLabels,
  TaskTitleSegment,
} from "./contract.js";

// 规则见 docs/ui/task-title-reference-display.md「解析规则」；只做显示层派生，不改存储标题。

const DEFAULT_FALLBACK_LABELS: TaskTitleFallbackLabels = {
  session: "Referenced session",
  image: "Image",
};

const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|heic|heif|avif|tiff?)$/i;
// 网址/路径结尾的标点与 CLI 截断产生的 `...` 不属于引用本身，作为普通文本保留。
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}'"，。；：！？）」』、…]+$/u;
// CJK 符号/标点、统一汉字、全角字符；以 regex 转义文本保存，避免格式化工具改写成不可见字符。
const CJK = "\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef";
// 只在最后一段文件名带扩展名、且后面紧贴中文时切开（`b.html打不开`）。
const FILE_NAME_CJK_SUFFIX_PATTERN = new RegExp(
  String.raw`^([^\\/]*\.[A-Za-z0-9]{1,8})(?=[${CJK}])`,
);
const LEADING_SKILL_PATTERN = /^\$([A-Za-z][\w:.-]*)(?=\s|$)/;
const LEADING_SLASH_SKILL_PATTERN = /^\/([A-Za-z0-9][\w:.-]*)(?=\s|$)/;
// 路径与 #sess_ 前面不能是单词字符或路径字符，避免把 `and/or/x` 这类正文判成路径。
const PATH_BOUNDARY = String.raw`(?<![A-Za-z0-9_.\-/\\:~#])`;

const TOKEN_PATTERN = new RegExp(
  [
    String.raw`(?<link>\[(?<linkLabel>(?:\\.|[^\\\]])*)\]\((?:<(?<linkAngle>[^>]*)>?|(?<linkDest>[^)\s]*))\)?)`,
    String.raw`(?<placeholder>\[image(?: #\d+)?\])`,
    String.raw`(?<deepLink>[zy]code:\/\/\S*)`,
    String.raw`(?<url>https?:\/\/[^\s/?#${CJK}]+[^\s${CJK}]*)`,
    String.raw`(?<fileUrl>file:\/\/\S+)`,
    String.raw`${PATH_BOUNDARY}(?<path>(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+|~[\\/]|\.{1,2}[\\/]|\/[^\s/]+\/)\S*)`,
    String.raw`${PATH_BOUNDARY}(?<session>#sess_[\w.-]*)`,
  ].join("|"),
  "giu",
);

function unescapeMarkdownText(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitTrailingPunctuation(token: string): {
  core: string;
  rest: string;
} {
  const match = TRAILING_PUNCTUATION_PATTERN.exec(token);
  if (!match || match.index === 0) return { core: token, rest: "" };
  return { core: token.slice(0, match.index), rest: token.slice(match.index) };
}

function fileSegment(path: string, fallback: TaskTitleFallbackLabels): TaskTitleSegment {
  const leaf = getPathLeaf(path.trim()) || path.trim();
  const isImage = IMAGE_EXTENSION_PATTERN.test(leaf);
  return { kind: isImage ? "image" : "file", label: leaf || fallback.image };
}

function urlHost(url: string): string {
  const host = /^https?:\/\/([^/?#\s]+)/i.exec(url)?.[1] ?? url;
  return host.slice(host.lastIndexOf("@") + 1);
}

class SegmentBuilder {
  readonly segments: TaskTitleSegment[] = [];

  text(value: string) {
    if (!value) return;
    const last = this.segments.at(-1);
    if (last?.kind === "text") last.label += value;
    else this.segments.push({ kind: "text", label: value });
  }

  push(segment: TaskTitleSegment, rest = "") {
    this.segments.push(segment);
    this.text(rest);
  }
}

/**
 * 把任务标题解析为「图标 + 简短名称」片段。纯函数：不读状态、不访问网络或文件。
 * 会话标题通过 `resolveSessionTitle` 从调用方的任务列表查找。
 */
export function parseTaskTitleDisplay(
  title: string,
  options: ParseTaskTitleDisplayOptions = {},
): TaskTitleSegment[] {
  const fallback = options.fallbackLabels ?? DEFAULT_FALLBACK_LABELS;
  const sessionLabel = (taskId: string | undefined) =>
    (taskId ? options.resolveSessionTitle?.(taskId)?.trim() : undefined) || fallback.session;
  const compact = title.replace(/\s+/g, " ").trim();
  const builder = new SegmentBuilder();
  let body = compact;

  const leadingSkill = LEADING_SKILL_PATTERN.exec(body) ?? LEADING_SLASH_SKILL_PATTERN.exec(body);
  if (leadingSkill?.[1]) {
    builder.push({ kind: "skill", label: leadingSkill[1] });
    body = body.slice(leadingSkill[0].length);
  }

  let cursor = 0;
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const token = match[0];
    const groups = match.groups ?? {};
    builder.text(body.slice(cursor, start));
    cursor = start + token.length;

    if (groups.link !== undefined) {
      const label = unescapeMarkdownText(groups.linkLabel ?? "").trim();
      const destination = (groups.linkAngle ?? groups.linkDest ?? "").trim();
      if (destination.startsWith("#sess_")) {
        const named = label.replace(/^#/, "").trim();
        builder.push({
          kind: "session",
          label: named || sessionLabel(destination.slice(1)),
        });
      } else if (destination.startsWith("plugin://")) {
        builder.text(label.replace(/^@/, "") || destination.slice("plugin://".length));
      } else if (label.startsWith("$")) {
        builder.push({ kind: "skill", label: label.slice(1) });
      } else if (/^https?:\/\//i.test(destination)) {
        const readable = label && !/^https?:\/\//i.test(label) ? label : urlHost(destination);
        builder.push({ kind: "url", label: readable });
      } else {
        builder.push(fileSegment(label.replace(/^@/, "") || destination, fallback));
      }
      continue;
    }

    if (groups.placeholder !== undefined) {
      builder.push({ kind: "image", label: fallback.image });
      continue;
    }

    if (groups.deepLink !== undefined) {
      const { core, rest } = splitTrailingPunctuation(token);
      // 60 字符截断后的深链（如 `zcode://session/open?tas`）无法完整解析，仍按会话引用显示。
      const taskIdParam = /[?&]taskId=([^&#\s]+)/.exec(core)?.[1];
      const taskId =
        parseSessionDeepLink(core)?.taskId ?? (taskIdParam ? safeDecode(taskIdParam) : undefined);
      builder.push({ kind: "session", label: sessionLabel(taskId) }, rest);
      continue;
    }

    if (groups.url !== undefined) {
      const { core, rest } = splitTrailingPunctuation(token);
      builder.push({ kind: "url", label: urlHost(core) }, rest);
      continue;
    }

    if (groups.fileUrl !== undefined) {
      const { core, rest } = splitTrailingPunctuation(token);
      builder.push(fileSegment(safeDecode(core.replace(/^file:\/\/\/?/i, "")), fallback), rest);
      continue;
    }

    if (groups.path !== undefined) {
      let pathToken = token;
      let suffix = "";
      const separatorIndex = Math.max(pathToken.lastIndexOf("/"), pathToken.lastIndexOf("\\"));
      const tail = pathToken.slice(separatorIndex + 1);
      const tailMatch = FILE_NAME_CJK_SUFFIX_PATTERN.exec(tail);
      if (tailMatch?.[1]) {
        const cut = separatorIndex + 1 + tailMatch[1].length;
        suffix = pathToken.slice(cut);
        pathToken = pathToken.slice(0, cut);
      }
      const { core, rest } = splitTrailingPunctuation(pathToken);
      builder.push(fileSegment(core, fallback), rest + suffix);
      continue;
    }

    if (groups.session !== undefined) {
      const { core, rest } = splitTrailingPunctuation(token);
      builder.push({ kind: "session", label: sessionLabel(core.slice(1)) }, rest);
      continue;
    }

    builder.text(token);
  }
  builder.text(body.slice(cursor));

  const segments = builder.segments.filter((segment) => segment.label.length > 0);
  if (segments.length === 0) return [{ kind: "text", label: compact || title }];
  return segments;
}

/** 片段的可读文本，用于 title / 无障碍名称；不含原始路径。 */
export function getTaskTitleDisplayText(segments: readonly TaskTitleSegment[]): string {
  return segments.map((segment) => segment.label).join("");
}
