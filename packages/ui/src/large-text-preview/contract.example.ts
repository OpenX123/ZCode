import type { FileTextSlice } from "@zcode/shared";
import type { TextFilePreviewClassification } from "./contract.js";

/** 5MB 日志的首块：截断且未超过 50MB，进入大文件简化模式。 */
export const largeTextFirstChunkExample = {
  path: "/workspace/app.log",
  content: "line 1\nline 2\npart",
  offset: 0,
  bytesRead: 1024 * 1024,
  totalBytes: 5 * 1024 * 1024,
  truncated: true,
  isBinary: false,
} satisfies FileTextSlice;

export const largeTextClassificationExample = {
  kind: "large",
  firstChunk: largeTextFirstChunkExample,
} satisfies TextFilePreviewClassification;
