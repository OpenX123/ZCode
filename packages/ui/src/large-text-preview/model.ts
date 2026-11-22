import type { FileTextSlice } from "@zcode/shared";
import type {
  ChunkedTextLines,
  TextChunkReader,
  TextFilePreviewClassification,
} from "./contract.js";

/** 1MB–50MB：大文件简化模式；>50MB：提示外部编辑器。本地与远程同一上限。 */
export const TEXT_PREVIEW_LARGE_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** 单次 RPC 分块大小，与 service 层 MAX_TEXT_READ_BYTES 对齐。 */
export const TEXT_PREVIEW_CHUNK_BYTES = 1024 * 1024;

/**
 * 根据首块读取结果判定预览档位。二进制按首块探测结论直接交给正常分支显示“不可预览”；
 * 未截断即完整文档；截断后按 totalBytes 区分大文件简化模式与超限提示。
 */
export function classifyTextFilePreview(firstChunk: FileTextSlice): TextFilePreviewClassification {
  if (firstChunk.isBinary || !firstChunk.truncated) {
    return { kind: "full", preview: firstChunk };
  }
  if (firstChunk.totalBytes > TEXT_PREVIEW_LARGE_FILE_MAX_BYTES) {
    return { kind: "tooLarge", totalBytes: firstChunk.totalBytes };
  }
  return { kind: "large", firstChunk };
}

export const EMPTY_CHUNKED_TEXT_LINES: ChunkedTextLines = {
  lines: [],
  pendingTail: "",
  nextOffset: 0,
  done: false,
};

/**
 * 把一个分块追加到行缓冲：上一块未结束的行与本块开头合并，保证行号全局连续。
 * service 已保证块边界落在 UTF-8 字符边界，这里只处理行边界；CRLF 的 `\r` 随行一起去除。
 * 读到 EOF 时把剩余尾行作为最后一行落定。
 */
export function appendTextChunk(state: ChunkedTextLines, chunk: FileTextSlice): ChunkedTextLines {
  const text = state.pendingTail + chunk.content;
  const parts = text.split("\n");
  const pendingTail = parts.pop() ?? "";
  const completed = parts.map(stripTrailingCarriageReturn);
  const nextOffset = chunk.offset + chunk.bytesRead;
  const done = !chunk.truncated || chunk.bytesRead === 0;
  const lines = state.lines.concat(completed);
  if (done) {
    // 文件以换行结尾时不额外制造空行，与 CodeViewer 的逐行语义一致。
    if (pendingTail.length > 0 || lines.length === 0) {
      lines.push(stripTrailingCarriageReturn(pendingTail));
    }
    return { lines, pendingTail: "", nextOffset, done: true };
  }
  return { lines, pendingTail, nextOffset, done: false };
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * “仍然渲染”：从首块之后按 1MB 顺序读取到 EOF，拼接为单个完整文档。
 * `isCancelled` 用于 source 切换后丢弃迟到结果；总量受 50MB 上限约束。
 */
export async function readFullTextFile(
  firstChunk: FileTextSlice,
  read: TextChunkReader,
  isCancelled: () => boolean = () => false,
): Promise<FileTextSlice | null> {
  const parts = [firstChunk.content];
  let offset = firstChunk.offset + firstChunk.bytesRead;
  let truncated = firstChunk.truncated;
  while (truncated && offset < Math.min(firstChunk.totalBytes, TEXT_PREVIEW_LARGE_FILE_MAX_BYTES)) {
    const chunk = await read({ offset, length: TEXT_PREVIEW_CHUNK_BYTES });
    if (isCancelled()) return null;
    if (chunk.isBinary) break;
    parts.push(chunk.content);
    if (chunk.bytesRead === 0) break;
    offset = chunk.offset + chunk.bytesRead;
    truncated = chunk.truncated;
  }
  const content = parts.join("");
  return {
    ...firstChunk,
    content,
    offset: 0,
    bytesRead: offset,
    truncated: false,
  };
}
