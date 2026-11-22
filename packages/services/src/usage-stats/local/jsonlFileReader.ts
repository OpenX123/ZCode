import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** 单行上限：超过即丢弃到下一换行，避免巨大 tool_result 行占满内存。 */
export const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const TAIL_HASH_BYTES = 256;
const READ_CHUNK_BYTES = 1024 * 1024;

export interface JsonlReadResult {
  /** 最后一个完整行（含换行符）结束的字节位置；未写完的尾行不推进。 */
  endOffset: number;
  oversizedLines: number;
}

/**
 * 从 startOffset 起流式读取 jsonl，按字节切行（不依赖 readline，保证游标是精确字节偏移）。
 * onLine 收到去掉 `\r` 的 UTF-8 文本。
 */
export async function readJsonlLines(
  path: string,
  startOffset: number,
  onLine: (line: string) => void,
  maxLineBytes = MAX_JSONL_LINE_BYTES,
): Promise<JsonlReadResult> {
  let position = startOffset;
  let endOffset = startOffset;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  let oversizedLines = 0;

  const stream = createReadStream(path, { start: startOffset, highWaterMark: READ_CHUNK_BYTES });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let lineStart = 0;
    let newline = chunk.indexOf(0x0a, lineStart);
    while (newline !== -1) {
      if (discarding) {
        discarding = false;
      } else {
        const piece = chunk.subarray(lineStart, newline);
        if (pendingBytes + piece.length > maxLineBytes) {
          oversizedLines += 1;
        } else {
          const lineBuffer =
            pendingBytes > 0 ? Buffer.concat([...pending, piece], pendingBytes + piece.length) : piece;
          let line = lineBuffer.toString("utf8");
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.length > 0) onLine(line);
        }
      }
      pending = [];
      pendingBytes = 0;
      endOffset = position + newline + 1;
      lineStart = newline + 1;
      newline = chunk.indexOf(0x0a, lineStart);
    }
    if (lineStart < chunk.length && !discarding) {
      const rest = chunk.subarray(lineStart);
      if (pendingBytes + rest.length > maxLineBytes) {
        discarding = true;
        oversizedLines += 1;
        pending = [];
        pendingBytes = 0;
      } else {
        // 复制一份：stream 可能复用底层 buffer。
        pending.push(Buffer.from(rest));
        pendingBytes += rest.length;
      }
    }
    position += chunk.length;
  }
  return { endOffset, oversizedLines };
}

/** offset 之前最多 256 字节的 sha1，用来识别文件被截断或改写。 */
export async function hashTailBefore(path: string, offset: number): Promise<string> {
  const length = Math.min(TAIL_HASH_BYTES, offset);
  if (length <= 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    return createHash("sha1").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

/** 递归收集 *.jsonl（不跟随符号链接），目录不存在时返回空。 */
export async function listJsonlFiles(root: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root, 1);
  return files.sort();
}
