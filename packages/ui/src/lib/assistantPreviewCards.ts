import {
  buildConversationPreviewArtifactCandidatesFromReferences,
  CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
} from "@zcode/shared";
import {
  cleanAssistantFilePathCandidate,
  extractAssistantFileReferences,
  getAssistantPreviewFileTypeDefinition,
  hasAssistantPreviewFileChangeCandidates,
  isAssistantPreviewHtmlPath,
  parseAssistantFileUrlPath,
  resolveAssistantRawFilePath,
  type AssistantFileReference,
  type AssistantPreviewFileKind,
  type AssistantPreviewFileSubtitleId,
} from "@/lib/assistantFileReferences.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";

export {
  extractAssistantFileReferences,
  hasAssistantPreviewFileChangeCandidates,
  isAssistantPreviewHtmlPath,
} from "@/lib/assistantFileReferences.js";
export type {
  AssistantFileReference,
  AssistantPreviewFileKind,
} from "@/lib/assistantFileReferences.js";

export const ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT = CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT;
export const ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT = CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT;

export interface AssistantPreviewCardsAutoOpenRequest {
  key: string;
  sources: CodeViewerSource[];
}

export type AssistantPreviewCard =
  | {
      id: string;
      type: "website";
      title: string;
      subtitleId: "chat.previewCards.htmlWebsite";
      url: string;
      filePath?: string;
    }
  | {
      id: string;
      type: "markdown";
      kind: "markdown";
      title: string;
      subtitleId: "chat.previewCards.markdown";
      path: string;
    }
  | {
      id: string;
      type: "file";
      kind: Exclude<AssistantPreviewFileKind, "markdown" | "html">;
      title: string;
      subtitleId: Exclude<
        AssistantPreviewFileSubtitleId,
        "chat.previewCards.markdown" | "chat.previewCards.htmlWebsite"
      >;
      path: string;
    };

export interface AssistantPreviewCardFileStatService {
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
}

const STRICT_FILE_HTML_URL_RE =
  /^file:\/\/(?:localhost\/|\/|[^/\s<>()\]`"'*，。！？；：、]+\/)[^\s<>()\]`"'*，。！？；：、]+\.html?(?:[?#][^\s<>()\]`"'*，。！？；：、]*)?$/i;

interface AssistantPreviewCardOptions {
  changedFilePaths?: readonly string[];
  homePath?: string;
  suppressWebRemoteCards?: boolean;
}

interface PositionedCard {
  card: AssistantPreviewCard;
  position: number;
}

function normalizeTrailingUrlText(url: string): string {
  return url.trim().replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, "");
}

export function isValidAssistantPreviewWebsiteUrl(url: string): boolean {
  const trimmedUrl = normalizeTrailingUrlText(url.trim());
  if (!trimmedUrl) return false;

  const isFileHtmlUrl = STRICT_FILE_HTML_URL_RE.test(trimmedUrl);
  if (!isFileHtmlUrl && !/^https?:\/\//iu.test(trimmedUrl)) return false;

  try {
    const parsedUrl = new URL(trimmedUrl);
    if (parsedUrl.protocol === "file:") return isFileHtmlUrl;

    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : null;
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      parsedUrl.username.length === 0 &&
      parsedUrl.password.length === 0 &&
      Boolean(parsedUrl.hostname) &&
      (port === null || (port > 0 && port <= 65_535))
    );
  } catch {
    return false;
  }
}

export function shouldOpenAssistantHtmlInBrowser(params: {
  compactForRemoteControl?: boolean;
  path: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): boolean {
  return (
    isAssistantPreviewHtmlPath(params.path) &&
    params.compactForRemoteControl !== true &&
    !params.workspaceIdentity?.trim() &&
    !params.workspaceRemoteSessionId
  );
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function resolveChangedFilePath(workspacePath: string, path: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) {
    return cleanAssistantFilePathCandidate(path);
  }
  return resolveAssistantRawFilePath(workspacePath, path) ?? path;
}

function findMatchingChangedFilePath(
  reference: AssistantFileReference,
  changedFilePaths: readonly string[],
  workspacePath: string,
): string | null {
  const normalizedReferencePath = normalizePathForCompare(reference.path);
  const normalizedChangedPaths = changedFilePaths.map((path) => {
    const resolvedPath = resolveChangedFilePath(workspacePath, path);
    return { path: resolvedPath, normalized: normalizePathForCompare(resolvedPath) };
  });
  const exact = normalizedChangedPaths.find(
    (candidate) => candidate.normalized === normalizedReferencePath,
  );
  if (exact) return exact.path;

  const cleanedRaw = cleanAssistantFilePathCandidate(reference.raw);
  if (cleanedRaw.includes("/") || cleanedRaw.includes("\\") || /^file:/i.test(cleanedRaw)) {
    return null;
  }
  const leafMatches = normalizedChangedPaths.filter(
    (candidate) => getPathLeaf(candidate.normalized) === cleanedRaw,
  );
  return leafMatches.length === 1 ? leafMatches[0]!.path : null;
}

function buildFileCard(reference: AssistantFileReference): AssistantPreviewCard {
  const definition = getAssistantPreviewFileTypeDefinition(reference.path)!;
  if (reference.kind === "markdown") {
    return {
      id: `markdown:${reference.path}`,
      type: "markdown",
      kind: "markdown",
      title: getPathLeaf(reference.path),
      subtitleId: "chat.previewCards.markdown",
      path: reference.path,
    };
  }
  if (reference.kind === "html") {
    return {
      id: `website:${toFileUrl(reference.path)}`,
      type: "website",
      title: getPathLeaf(reference.path),
      subtitleId: "chat.previewCards.htmlWebsite",
      url: toFileUrl(reference.path),
      filePath: reference.path,
    };
  }
  return {
    id: `file:${reference.kind}:${reference.path}`,
    type: "file",
    kind: reference.kind,
    title: getPathLeaf(reference.path),
    subtitleId: definition.subtitleId as Extract<
      AssistantPreviewCard,
      { type: "file" }
    >["subtitleId"],
    path: reference.path,
  };
}

function getCardSeenKey(card: AssistantPreviewCard): string {
  const filePath = getAssistantPreviewCardFilePath(card);
  return filePath ? `file:${normalizePathForCompare(filePath)}` : card.id;
}

export function buildAssistantPreviewCards(
  content: string,
  workspacePath: string,
  options: AssistantPreviewCardOptions = {},
): AssistantPreviewCard[] {
  if (!content.trim()) return [];
  return buildAssistantPreviewCardsFromReferences(
    content,
    workspacePath,
    extractAssistantFileReferences(content, workspacePath, { homePath: options.homePath }),
    options,
  );
}

export function buildAssistantPreviewCardsFromReferences(
  content: string,
  workspacePath: string,
  references: readonly AssistantFileReference[],
  options: AssistantPreviewCardOptions = {},
): AssistantPreviewCard[] {
  if (!content.trim()) return [];

  const changedFilePaths = options.changedFilePaths ?? [];
  const genUiSources = collectGenUiSourcePaths(content);
  const positionedCards: PositionedCard[] = [];
  // 1.6.1 起不再从正文 URL（localhost / 闭合链接 / text fence / 裸 URL）生成网站卡：
  // 用户反馈正文已有可点链接，额外的网站卡与之重复且令人困惑（Q41=A）；HTML 文件卡保留。
  const fileReferences: AssistantFileReference[] = [];
  for (const reference of references) {
    if (options.suppressWebRemoteCards && reference.kind === "html") continue;

    let resolvedReference = reference;
    if (reference.kind === "markdown" || reference.kind === "html") {
      const changedPath = findMatchingChangedFilePath(reference, changedFilePaths, workspacePath);
      if (!changedPath) continue;
      resolvedReference = { ...reference, path: changedPath };
    }
    // 可视化已在正文展示；通用文件引用识别会再次命中其 HTML 路径，需在候选限额前去重。
    if (matchesGenUiSourcePath(resolvedReference.path, genUiSources)) continue;
    fileReferences.push(resolvedReference);
  }

  const previewCandidates = buildConversationPreviewArtifactCandidatesFromReferences({
    references: fileReferences,
    productTurnId: "",
    workspacePath,
    fileChanges: changedFilePaths.map((path) => ({ path, state: "active" as const })),
    // Renderer 仍需展示已解析的 Home-relative/file URL 卡片；Share Service 会在自己的
    // Host source 上再次执行 workspace 边界校验。
    enforceWorkspaceBoundary: false,
  });
  const referencesByPath = new Map(
    fileReferences.map((reference) => [normalizePathForCompare(reference.path), reference]),
  );
  for (const candidate of previewCandidates) {
    const reference = referencesByPath.get(normalizePathForCompare(candidate.sourceRef));
    if (!reference) continue;
    positionedCards.push({
      position: reference.start,
      card: buildFileCard({ ...reference, path: candidate.sourceRef }),
    });
  }

  positionedCards.sort((left, right) => right.position - left.position);
  const seen = new Set<string>();
  const cards: AssistantPreviewCard[] = [];
  for (const candidate of positionedCards) {
    const key = getCardSeenKey(candidate.card);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(candidate.card);
    if (cards.length === ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT) break;
  }
  return cards;
}

export function getAssistantPreviewCardFilePath(card: AssistantPreviewCard): string | null {
  return card.type === "website"
    ? (card.filePath ?? parseAssistantFileUrlPath(card.url))
    : card.path;
}

export function requiresAssistantPreviewCardFileStat(card: AssistantPreviewCard): boolean {
  return getAssistantPreviewCardFilePath(card) !== null;
}
