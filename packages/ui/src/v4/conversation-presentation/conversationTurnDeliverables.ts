import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationDeliverable, ConversationDeliverableScope } from "./contract.js";

interface SourceRange {
  start: number;
  end: number;
}
interface Candidate extends SourceRange {
  target: string;
  image?: boolean;
  standalone?: boolean;
  textFence?: boolean;
}

// 仅缓存原行派生，WeakMap 不拥有历史生命周期，也不形成第二份会话事实。
const rowCache = new WeakMap<
  AssistantTextRow,
  { text: string; streaming: boolean; references: readonly ConversationDeliverable[] }
>();

function overlaps(start: number, end: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function httpTarget(value: string): boolean {
  if (!/^https?:\/\/[^\s<>`]+$/i.test(value)) return false;
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

function cleanTarget(raw: string): string | undefined {
  let target = raw.trim();
  const first = target[0];
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "<": ">" };
  if (first && pairs[first]) {
    const close = target.indexOf(pairs[first]!, 1);
    if (close < 0 || !/^(?:\s+["'][^"']*["'])?$/.test(target.slice(close + 1))) return undefined;
    target = target.slice(1, close);
  } else {
    target = target.replace(/\s+["'][^"']*["']$/, "");
    if (/["'“”‘’<>]/.test(target)) return undefined;
  }
  if (!target || /[\n\r`]/.test(target) || target.startsWith("#")) return undefined;
  if (httpTarget(target)) return target;
  // 除 Windows 盘符外不接纳协议；打开与路径权限仍由既有 MessageFileLink 校验。
  if (/^[a-z][\w+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return undefined;
  return target;
}

function protectedCode(text: string): { ranges: SourceRange[]; candidates: Candidate[] } {
  const ranges: SourceRange[] = [];
  const candidates: Candidate[] = [];
  const opening = /^ {0,3}(`{3,}|~{3,})([^\n\r]*)(?:\r?\n|$)/gm;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    if (overlaps(match.index, match.index + 1, ranges)) continue;
    const delimiter = match[1]!;
    const bodyStart = match.index + match[0].length;
    const closing = new RegExp(
      `^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*(?:\\r?\\n|$)`,
      "gm",
    );
    closing.lastIndex = bodyStart;
    const close = closing.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    ranges.push({ start: match.index, end });
    const target = close ? text.slice(bodyStart, close.index).trim() : "";
    if (match[2]!.trim().toLowerCase() === "text" && httpTarget(target)) {
      candidates.push({
        start: match.index,
        end: close!.index + close![0].trimEnd().length,
        target,
        standalone: true,
        textFence: true,
      });
    }
    opening.lastIndex = end;
  }
  for (const match of text.matchAll(/^(?: {4}|\t).*$/gm)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(/(`+)([\s\S]*?)(\1)(?!`)/g)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return { ranges, candidates };
}

function markdownCandidates(text: string, ranges: readonly SourceRange[]): Candidate[] {
  const candidates: Candidate[] = [];
  const opening = /!?\[[^\]\n]*\]\(/g;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const start = match.index;
    if (overlaps(start, start + match[0].length, ranges) || text[start - 1] === "\\") continue;
    const targetStart = start + match[0].length;
    let depth = 1;
    let end = targetStart;
    let quote = "";
    for (; end < text.length; end += 1) {
      const char = text[end]!;
      if (char === "\n" || char === "\r") break;
      if (char === "\\") {
        end += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "“" || char === "‘") {
        quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      } else if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) break;
    }
    if (depth !== 0 || overlaps(start, end + 1, ranges)) continue;
    const target = cleanTarget(text.slice(targetStart, end));
    if (target) candidates.push({ start, end: end + 1, target, image: match[0].startsWith("!") });
    opening.lastIndex = end + 1;
  }
  return candidates;
}

function sourceContext(
  text: string,
  candidate: Candidate,
  ranges: readonly SourceRange[],
): SourceRange {
  const boundaries = [...text.matchAll(/\r?\n[ \t]*\r?\n/g)];
  const previous = boundaries.findLast((match) => match.index + match[0].length <= candidate.start);
  let start = previous ? previous.index + previous[0].length : 0;
  const next = boundaries.find((match) => match.index >= candidate.end);
  let end = next?.index ?? text.length;
  if (candidate.standalone && start > 0) {
    const previousEnd = previous!.index;
    const beforePrevious = boundaries.findLast((match) => match.index < previousEnd);
    const from = beforePrevious ? beforePrevious.index + beforePrevious[0].length : 0;
    // 独立 URL 的用途常在前一个段落；不把前一段代码示例当作说明带出。
    if (!overlaps(from, previousEnd, ranges)) start = from;
  }
  while (start < candidate.start && /\s/.test(text[start]!)) start += 1;
  while (end > candidate.end && /\s/.test(text[end - 1]!)) end -= 1;
  return { start, end };
}

function extractRow(row: AssistantTextRow): readonly ConversationDeliverable[] {
  const cached = rowCache.get(row);
  const streaming = row.state === "streaming";
  if (cached?.text === row.text && cached.streaming === streaming) return cached.references;
  const { ranges, candidates } = protectedCode(row.text);
  candidates.push(...markdownCandidates(row.text, ranges));
  for (const match of row.text.matchAll(/^[ \t]*(https?:\/\/[^\s<>`]+)[ \t]*(?:\r?\n|$)/gm)) {
    const target = match[1]!;
    const start = match.index + match[0].indexOf(target);
    const end = start + target.length;
    if (
      !overlaps(start, end, ranges) &&
      httpTarget(target) &&
      (!streaming || /\r?\n$/.test(match[0]))
    ) {
      candidates.push({ start, end, target, standalone: true });
    }
  }
  const references = candidates
    .sort((a, b) => a.start - b.start)
    .map((candidate): ConversationDeliverable => {
      const context = sourceContext(row.text, candidate, ranges);
      const kind = candidate.image ? "image" : httpTarget(candidate.target) ? "link" : "file";
      return {
        key: `${row.rowId}:${candidate.start}:${candidate.end}:${kind}`,
        sourceRowId: row.rowId,
        start: candidate.start,
        end: candidate.end,
        kind,
        sourceFormat: candidate.textFence
          ? "textFence"
          : candidate.standalone
            ? "standaloneUrl"
            : "markdown",
        target: candidate.target,
        contextStart: context.start,
        contextEnd: context.end,
        contextText: row.text.slice(context.start, context.end),
      };
    });
  rowCache.set(row, { text: row.text, streaming, references });
  return references;
}

export function extractConversationDeliverables(
  rows: readonly AssistantTextRow[],
): readonly ConversationDeliverable[] {
  const seen = new Set<string>();
  return rows.flatMap((row) =>
    extractRow(row).filter((reference) => {
      if (seen.has(reference.target)) return false;
      seen.add(reference.target);
      return true;
    }),
  );
}

export function resolveConversationDeliverableKey(
  reference: ConversationDeliverable,
  scope: ConversationDeliverableScope,
  turnId: string,
): string {
  return JSON.stringify([
    scope.workspaceIdentity?.trim() || scope.workspacePath,
    scope.workspaceRemoteSessionId ?? "",
    scope.sessionId ?? "",
    scope.logEpoch ?? "",
    turnId,
    reference.key,
  ]);
}
