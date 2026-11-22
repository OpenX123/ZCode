import { describe, expect, it } from "vitest";
import { largeTextClassificationExample, largeTextFirstChunkExample } from "./contract.example.js";
import { EMPTY_CHUNKED_TEXT_LINES, appendTextChunk, classifyTextFilePreview } from "./model.js";

describe("large-text-preview 合同", () => {
  it("示例首块按公开函数归入大文件档", () => {
    expect(classifyTextFilePreview(largeTextFirstChunkExample)).toEqual(
      largeTextClassificationExample,
    );
  });

  it("首块的未结束行保留到下一块拼接", () => {
    const state = appendTextChunk(EMPTY_CHUNKED_TEXT_LINES, largeTextFirstChunkExample);
    expect(state.lines).toEqual(["line 1", "line 2"]);
    expect(state.pendingTail).toBe("part");
    expect(state.nextOffset).toBe(1024 * 1024);
  });
});
