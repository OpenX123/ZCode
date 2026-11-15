import type { AssistantMediaRef, AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { getMediaPreviewFormat } from "@zcode/shared/media-preview";
import { extractConversationDeliverables } from "./conversationTurnDeliverables.js";

const mediaExtensions: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export function classifyAssistantMedia(
  source: string,
  mimeType?: string,
): Pick<AssistantMediaRef, "mediaType" | "mimeType"> | null {
  const path = source.split(/[?#]/u, 1)[0] ?? "";
  const mime =
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() ||
    getMediaPreviewFormat(path)?.mediaType ||
    mediaExtensions[path.split(".").at(-1)?.toLowerCase() ?? ""];
  const kind = mime?.split("/", 1)[0];
  return mime && (kind === "image" || kind === "audio" || kind === "video")
    ? { mediaType: kind, mimeType: mime }
    : null;
}

/** 原文仅作纯展示派生；不建立协议行或媒体事实。 */
export function assistantPresentationReferences(text: string, streaming = false) {
  const row: AssistantTextRow = {
    rowId: 0,
    entityId: "presentation",
    turnId: "presentation",
    createdAt: 0,
    createdAtSeq: 0,
    kind: "assistantText",
    text,
    state: streaming ? "streaming" : "complete",
  };
  return extractConversationDeliverables([row]);
}
