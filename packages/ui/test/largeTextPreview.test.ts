import { describe, expect, it, vi } from "vitest";
import type { FileTextSlice } from "@zcode/shared";
import {
  EMPTY_CHUNKED_TEXT_LINES,
  TEXT_PREVIEW_LARGE_FILE_MAX_BYTES,
  appendTextChunk,
  classifyTextFilePreview,
  readFullTextFile,
} from "@/large-text-preview/index.js";

function slice(overrides: Partial<FileTextSlice>): FileTextSlice {
  return {
    path: "/workspace/app.log",
    content: "",
    offset: 0,
    bytesRead: 0,
    totalBytes: 0,
    truncated: false,
    isBinary: false,
    ...overrides,
  };
}

describe("classifyTextFilePreview", () => {
  it("keeps complete documents in the normal render path", () => {
    const preview = slice({ content: "ok", bytesRead: 2, totalBytes: 2 });
    expect(classifyTextFilePreview(preview)).toEqual({ kind: "full", preview });
  });

  it("enters large file mode between 1MB and 50MB", () => {
    const firstChunk = slice({
      bytesRead: 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
      truncated: true,
    });
    expect(classifyTextFilePreview(firstChunk)).toEqual({ kind: "large", firstChunk });
  });

  it("asks for an external editor above 50MB", () => {
    const firstChunk = slice({
      bytesRead: 1024 * 1024,
      totalBytes: TEXT_PREVIEW_LARGE_FILE_MAX_BYTES + 1,
      truncated: true,
    });
    expect(classifyTextFilePreview(firstChunk)).toEqual({
      kind: "tooLarge",
      totalBytes: TEXT_PREVIEW_LARGE_FILE_MAX_BYTES + 1,
    });
  });

  it("preserves binary detection for truncated binary chunks", () => {
    const binary = slice({ isBinary: true, truncated: true, totalBytes: 80 * 1024 * 1024 });
    expect(classifyTextFilePreview(binary).kind).toBe("full");
  });
});

describe("appendTextChunk", () => {
  it("joins a line split across chunks and keeps line numbers continuous", () => {
    const first = appendTextChunk(
      EMPTY_CHUNKED_TEXT_LINES,
      slice({ content: "line 1\nline 2\nli", bytesRead: 16, totalBytes: 30, truncated: true }),
    );
    expect(first.lines).toEqual(["line 1", "line 2"]);
    expect(first.pendingTail).toBe("li");
    expect(first.nextOffset).toBe(16);
    expect(first.done).toBe(false);

    const second = appendTextChunk(
      first,
      slice({ content: "ne 3\r\n中文\n", offset: 16, bytesRead: 14, totalBytes: 30 }),
    );
    expect(second.lines).toEqual(["line 1", "line 2", "line 3", "中文"]);
    expect(second.done).toBe(true);
  });

  it("flushes the trailing line at EOF", () => {
    const state = appendTextChunk(
      EMPTY_CHUNKED_TEXT_LINES,
      slice({ content: "a\nb", bytesRead: 3, totalBytes: 3 }),
    );
    expect(state.lines).toEqual(["a", "b"]);
  });
});

describe("readFullTextFile", () => {
  it("reads remaining chunks sequentially from the first chunk end", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        slice({ content: "BB", offset: 2, bytesRead: 2, totalBytes: 6, truncated: true }),
      )
      .mockResolvedValueOnce(slice({ content: "CC", offset: 4, bytesRead: 2, totalBytes: 6 }));
    const result = await readFullTextFile(
      slice({ content: "AA", bytesRead: 2, totalBytes: 6, truncated: true }),
      read,
    );
    expect(read).toHaveBeenNthCalledWith(1, { offset: 2, length: 1024 * 1024 });
    expect(read).toHaveBeenNthCalledWith(2, { offset: 4, length: 1024 * 1024 });
    expect(result?.content).toBe("AABBCC");
    expect(result?.truncated).toBe(false);
  });

  it("drops late results after cancellation", async () => {
    let cancelled = false;
    const read = vi.fn(async () => {
      cancelled = true;
      return slice({ content: "BB", offset: 2, bytesRead: 2, totalBytes: 4 });
    });
    const result = await readFullTextFile(
      slice({ content: "AA", bytesRead: 2, totalBytes: 4, truncated: true }),
      read,
      () => cancelled,
    );
    expect(result).toBeNull();
  });
});
