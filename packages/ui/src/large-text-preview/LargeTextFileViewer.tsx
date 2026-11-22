import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type Ref, type RefCallback } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { EMPTY_CHUNKED_TEXT_LINES, TEXT_PREVIEW_CHUNK_BYTES, appendTextChunk } from "./model.js";
import type { ChunkedTextLines, LargeTextFileViewerProps } from "./contract.js";
import { logger } from "@/logger.js";

/** 距已加载内容底部不足该行数时读取下一块（约一屏）。 */
const LOAD_MORE_THRESHOLD_LINES = 80;

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as { current: T | null }).current = value;
}

/**
 * 1MB–50MB 文本的大文件简化模式：按 1MB 分块按需读取，虚拟滚动纯文本，不做高亮。
 * 分块状态只属于当前组件实例；PreviewPane 以 path 作为 key 挂载，切换 source 即重建，
 * 卸载后的迟到分块结果由 disposedRef 丢弃。
 */
export function LargeTextFileViewer({
  firstChunk,
  readChunk,
  fontSizePx,
  renderingAnyway,
  renderAnywayError,
  onRenderAnyway,
  onScroll,
  scrollContainerRef,
}: LargeTextFileViewerProps) {
  const { intl } = useZCodeIntl();
  const [state, setState] = useState<ChunkedTextLines>(() =>
    appendTextChunk(EMPTY_CHUNKED_TEXT_LINES, firstChunk),
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [chunkError, setChunkError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const disposedRef = useRef(false);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const lineHeight = Math.max(14, Math.round(fontSizePx * 1.6));
  const gutterChars = String(Math.max(state.lines.length, 1)).length + 1;

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const setScrollElement = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      scrollElementRef.current = element;
      assignRef(scrollContainerRef, element);
    },
    [scrollContainerRef],
  );

  const virtualizer = useVirtualizer({
    count: state.lines.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => lineHeight,
    overscan: 40,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? 0;

  const loadNextChunk = useCallback(() => {
    if (loadingRef.current || state.done) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setChunkError(null);
    const offset = state.nextOffset;
    void readChunk({ offset, length: TEXT_PREVIEW_CHUNK_BYTES })
      .then((chunk) => {
        if (disposedRef.current) return;
        setState((current) =>
          // 只接受与当前读取起点一致的块，防止重复请求把同一段文本追加两次。
          current.nextOffset === offset && !current.done
            ? appendTextChunk(current, chunk)
            : current,
        );
      })
      .catch((error: unknown) => {
        if (disposedRef.current) return;
        logger.warn("[LargeTextFileViewer] 读取文件分块失败", {
          offset,
          error: error instanceof Error ? error.message : String(error),
        });
        setChunkError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        loadingRef.current = false;
        if (!disposedRef.current) setLoadingMore(false);
      });
  }, [readChunk, state.done, state.nextOffset]);

  useEffect(() => {
    if (state.done || chunkError) return;
    if (lastVisibleIndex >= state.lines.length - LOAD_MORE_THRESHOLD_LINES) {
      loadNextChunk();
    }
  }, [chunkError, lastVisibleIndex, loadNextChunk, state.done, state.lines.length]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="large-text-file-viewer">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-ui-sm text-foreground-subtle">
        <span className="min-w-0 flex-1 truncate">
          {intl.formatMessage(
            { id: "preview.largeFile.notice" },
            { size: formatMegabytes(firstChunk.totalBytes) },
          )}
        </span>
        {renderAnywayError ? (
          <span className="shrink-0 truncate text-destructive">{renderAnywayError}</span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={renderingAnyway}
          onClick={onRenderAnyway}
          data-testid="large-text-file-render-anyway"
        >
          {renderingAnyway ? <Loader2Icon className="animate-spin" /> : null}
          <span>
            {intl.formatMessage({
              id: renderingAnyway
                ? "preview.largeFile.rendering"
                : "preview.largeFile.renderAnyway",
            })}
          </span>
        </Button>
      </div>
      <div
        ref={setScrollElement}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto font-mono text-foreground"
        style={{ fontSize: fontSizePx, lineHeight: `${lineHeight}px` }}
      >
        <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => (
            <div
              key={item.key}
              className="absolute left-0 top-0 flex w-max min-w-full whitespace-pre"
              style={{ height: lineHeight, transform: `translateY(${item.start}px)` }}
            >
              <span
                aria-hidden
                className="sticky left-0 shrink-0 select-none bg-background pr-3 pl-3 text-right text-foreground-subtlest"
                style={{ width: `${gutterChars + 2}ch` }}
              >
                {item.index + 1}
              </span>
              <span className="pr-4">{state.lines[item.index]}</span>
            </div>
          ))}
        </div>
        {loadingMore || chunkError ? (
          <div className="sticky left-0 flex items-center gap-2 px-3 py-2 text-ui-sm text-foreground-subtle">
            {chunkError ? (
              <>
                <span className="text-destructive">{chunkError}</span>
                <Button type="button" size="xs" variant="ghost" onClick={loadNextChunk}>
                  {intl.formatMessage({ id: "preview.largeFile.retry" })}
                </Button>
              </>
            ) : (
              <>
                <Loader2Icon className="size-3.5 animate-spin" />
                {intl.formatMessage({ id: "preview.largeFile.loadingMore" })}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
