import type { Ref, UIEventHandler } from "react";
import type { FileTextSlice } from "@zcode/shared";

/** 首块读取结果的预览档位（docs/ui/preview-pane.md「大文件预览」）。 */
export type TextFilePreviewClassification =
  | { kind: "full"; preview: FileTextSlice }
  | { kind: "large"; firstChunk: FileTextSlice }
  | { kind: "tooLarge"; totalBytes: number };

/** 分块行缓冲：只属于单个查看器实例，不跨 source 复用。 */
export interface ChunkedTextLines {
  /** 已确认完整（以换行结束）的行。 */
  lines: string[];
  /** 当前最后一块末尾尚未结束的行，等待与下一块开头拼接。 */
  pendingTail: string;
  /** 下一块读取起点（字节）。 */
  nextOffset: number;
  /** 是否已读到 EOF。 */
  done: boolean;
}

/** 由调用方绑定 path 与 workspace-scoped fileService 的分块读取函数。 */
export type TextChunkReader = (params: {
  offset: number;
  length: number;
}) => Promise<FileTextSlice>;

export interface LargeTextFileViewerProps {
  firstChunk: FileTextSlice;
  readChunk: TextChunkReader;
  fontSizePx: number;
  renderingAnyway: boolean;
  renderAnywayError: string | null;
  onRenderAnyway: () => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
}
