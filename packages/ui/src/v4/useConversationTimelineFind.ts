import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
  scrollConversationFindRangeIntoView,
} from "@/v4/conversationFindHighlightDom.js";
import {
  createConversationFindIndexBuilder,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
  type ConversationFindMatch,
  type ConversationFindMatchKey,
} from "@/v4/conversationFindIndex.js";
import type {
  ConversationTurnRenderUnit,
  ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";

const FIND_AUTO_LOAD_ROW_LIMIT = 1200;
const SEARCH_RESULT_HIGHLIGHT_DURATION_MS = 3000;

export interface UseConversationTimelineFindOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  /** 按「历史 + 尾轮」分区的 render unit；历史段引用在流式帧之间不变。 */
  renderUnits: ConversationTurnRenderUnitsPartition;
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  scrollToUnit: (unitIndex: number) => void;
}

function normalizeSearchResultSnippet(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceTextContainsSnippet(sourceText: string, snippet: string): boolean {
  const normalizedSnippet = normalizeSearchResultSnippet(snippet).toLocaleLowerCase();
  if (!normalizedSnippet) {
    return false;
  }
  return normalizeSearchResultSnippet(sourceText).toLocaleLowerCase().includes(normalizedSnippet);
}

type UnitFindCache = Map<
  string,
  { unit: ConversationTurnRenderUnit; source: ConversationFindMatch[]; loadedRowCount: number }
>;

/**
 * 把一段 unit 的命中按全局顺序追加到 matches，返回这些 unit 的 loadedRowCount 之和。
 * 修复原因：streaming delta 只会改变当前 running turn；稳定 turn 的全文索引可复用，
 * 避免每个 token 都扫描整段历史，导致长会话 renderer 主线程被持续占满。
 * 不在运行的 unit 依次在 lookups 里找上一份命中并写入 nextCache；运行中的 unit 每次重建。
 */
function appendUnitFindMatches({
  units,
  indexOffset,
  matches,
  cacheKeyPrefix,
  lookups,
  nextCache,
  build,
}: {
  units: readonly ConversationTurnRenderUnit[];
  indexOffset: number;
  matches: ConversationFindMatch[];
  cacheKeyPrefix: string;
  lookups: readonly UnitFindCache[];
  nextCache: UnitFindCache;
  build: (unit: ConversationTurnRenderUnit) => {
    matches: ConversationFindMatch[];
    loadedRowCount: number;
  };
}): number {
  let loadedRowCount = 0;
  units.forEach((unit, offset) => {
    const unitIndex = indexOffset + offset;
    const cacheKey = `${cacheKeyPrefix}:${unit.key}`;
    // 历史修订保留 turn key，但正文已改变；缓存必须跟随不可变投影身份失效。
    const cached = unit.isRunning
      ? undefined
      : lookups.map((cache) => cache.get(cacheKey)).find((entry) => entry?.unit === unit);
    const unitIndexResult = cached
      ? { matches: cached.source, loadedRowCount: cached.loadedRowCount }
      : build(unit);
    if (!unit.isRunning) {
      nextCache.set(
        cacheKey,
        cached ?? {
          unit,
          source: unitIndexResult.matches,
          loadedRowCount: unitIndexResult.loadedRowCount,
        },
      );
    }
    loadedRowCount += unitIndexResult.loadedRowCount;
    for (const match of unitIndexResult.matches) {
      // 新构建的命中尚未发布，直接补全位置；缓存命中只在窗口位置变化时复制。
      // 高频短查询可产生大量结果，不能在同一轮构建后再无条件复制全部对象。
      if (!cached) {
        match.globalIndex = matches.length;
        match.unitIndex = unitIndex;
      }
      matches.push(
        match.globalIndex === matches.length && match.unitIndex === unitIndex
          ? match
          : { ...match, globalIndex: matches.length, unitIndex },
      );
    }
  });
  return loadedRowCount;
}

export function useConversationTimelineFind({
  rootRef,
  renderUnits,
  rows,
  mountedRowsKey,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  sessionPhase,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  scrollToUnit,
}: UseConversationTimelineFindOptions) {
  const buildFindIndex = useMemo(() => createConversationFindIndexBuilder(), []);
  // 未查找时的固定空索引：依赖它的 effect 不会随每个流式帧重跑。
  const emptyFindIndex = useMemo(() => buildFindIndex([], ""), [buildFindIndex]);
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const findStable = sessionPhase !== "running" && sessionPhase !== "prewarming";
  const normalizedFindQuery = conversationFindQuery.trim().toLocaleLowerCase();
  // 历史段与尾段各自只保留当前段的 unit；两段之间迁移的 unit 由对方的表兜底命中。
  const historyFindCacheRef = useRef<UnitFindCache>(new Map());
  const tailFindCacheRef = useRef<UnitFindCache>(new Map());
  // Bug 根因：原先按全部 render unit 构建，即使未查找也要逐轮拼缓存键，流式帧成本随历史线性增长。
  // 历史段命中按 history 引用缓存，每帧只为尾段重建；未查找时直接返回固定空索引。
  const historyFindIndex = useMemo(() => {
    const matches: ConversationFindMatch[] = [];
    if (!normalizedFindQuery) {
      // 查找关闭时不再留着上一次查询的 unit 与命中（修改前每次调用都只保留当前窗口的 unit）。
      if (historyFindCacheRef.current.size > 0) historyFindCacheRef.current = new Map();
      return { matches, loadedRowCount: 0 };
    }
    const nextCache: UnitFindCache = new Map();
    const loadedRowCount = appendUnitFindMatches({
      units: renderUnits.history,
      indexOffset: 0,
      matches,
      cacheKeyPrefix: `${normalizedFindQuery}:${codeCommentCardsEnabled}`,
      lookups: [historyFindCacheRef.current, tailFindCacheRef.current],
      nextCache,
      build: (unit) =>
        buildFindIndex([unit], conversationFindQuery, {
          projectAssistantCodeComments: codeCommentCardsEnabled,
        }),
    });
    // 仅保留当前窗口，不让裁剪后的历史命中继续占用缓存。
    historyFindCacheRef.current = nextCache;
    return { matches, loadedRowCount };
  }, [
    buildFindIndex,
    codeCommentCardsEnabled,
    conversationFindQuery,
    normalizedFindQuery,
    renderUnits.history,
  ]);
  const conversationFindIndex = useMemo(() => {
    if (!normalizedFindQuery) {
      if (tailFindCacheRef.current.size > 0) tailFindCacheRef.current = new Map();
      return emptyFindIndex;
    }
    const matches = [...historyFindIndex.matches];
    const nextCache: UnitFindCache = new Map();
    // 尾段通常是正在运行的最后一轮，运行中的 unit 不缓存；尾段里已结束的 unit 与历史段一样复用。
    const tailRowCount = appendUnitFindMatches({
      units: renderUnits.tail,
      indexOffset: renderUnits.history.length,
      matches,
      cacheKeyPrefix: `${normalizedFindQuery}:${codeCommentCardsEnabled}`,
      lookups: [tailFindCacheRef.current, historyFindCacheRef.current],
      nextCache,
      build: (unit) =>
        buildFindIndex([unit], conversationFindQuery, {
          projectAssistantCodeComments: codeCommentCardsEnabled,
        }),
    });
    tailFindCacheRef.current = nextCache;
    return {
      query: normalizedFindQuery,
      matches,
      matchCount: matches.length,
      loadedRowCount: historyFindIndex.loadedRowCount + tailRowCount,
    };
  }, [
    buildFindIndex,
    codeCommentCardsEnabled,
    conversationFindQuery,
    emptyFindIndex,
    historyFindIndex,
    normalizedFindQuery,
    renderUnits,
  ]);
  const searchResultFindIndex = useMemo(
    () =>
      findStable && searchResultHighlightRequest
        ? buildFindIndex(
            [...renderUnits.history, ...renderUnits.tail],
            searchResultHighlightRequest.query,
            { projectAssistantCodeComments: codeCommentCardsEnabled },
          )
        : emptyFindIndex,
    [
      buildFindIndex,
      codeCommentCardsEnabled,
      emptyFindIndex,
      findStable,
      renderUnits,
      searchResultHighlightRequest,
    ],
  );
  const [resolvedFindActiveIndex, setResolvedFindActiveIndex] = useState(-1);
  const findActiveKeyRef = useRef<ConversationFindMatchKey | null>(null);
  const lastFindQueryRef = useRef("");
  const lastExternalActiveIndexRef = useRef(conversationFindActiveIndex);
  const lastFindScrollKeyRef = useRef("");
  const lastFindHighlightScrollKeyRef = useRef("");
  const lastFindAutoLoadAttemptRef = useRef("");
  const lastSearchResultAutoLoadAttemptRef = useRef("");
  const searchResultAppliedRequestRef = useRef<number | null>(null);
  const searchResultScrollRequestRef = useRef<number | null>(null);
  const searchResultCleanupTimerRef = useRef<number | undefined>(undefined);
  const activeFindMatch =
    resolvedFindActiveIndex >= 0
      ? (conversationFindIndex.matches[resolvedFindActiveIndex] ?? null)
      : null;

  useEffect(() => {
    if (!conversationFindIndex.query) {
      findActiveKeyRef.current = null;
      lastFindQueryRef.current = "";
      lastFindScrollKeyRef.current = "";
      lastFindHighlightScrollKeyRef.current = "";
      setResolvedFindActiveIndex(-1);
      clearConversationFindHighlights();
      onConversationFindMatchStateChange?.({ matchCount: 0, activeIndex: -1 });
      return;
    }

    const queryChanged = lastFindQueryRef.current !== conversationFindIndex.query;
    const externalActiveIndexChanged =
      lastExternalActiveIndexRef.current !== conversationFindActiveIndex;
    let nextActiveIndex = resolveConversationFindActiveIndex(
      conversationFindIndex,
      conversationFindActiveIndex,
    );

    if (!queryChanged && !externalActiveIndexChanged) {
      const rebasedIndex = findConversationMatchIndexByKey(
        conversationFindIndex,
        findActiveKeyRef.current,
      );
      if (rebasedIndex >= 0) {
        nextActiveIndex = rebasedIndex;
      }
    }

    const activeMatch =
      nextActiveIndex >= 0 ? (conversationFindIndex.matches[nextActiveIndex] ?? null) : null;
    findActiveKeyRef.current = getConversationFindMatchKey(activeMatch);
    lastFindQueryRef.current = conversationFindIndex.query;
    lastExternalActiveIndexRef.current = nextActiveIndex;
    setResolvedFindActiveIndex(nextActiveIndex);
    onConversationFindMatchStateChange?.({
      matchCount: conversationFindIndex.matchCount,
      activeIndex: nextActiveIndex,
    });
  }, [conversationFindActiveIndex, conversationFindIndex, onConversationFindMatchStateChange]);

  useEffect(() => {
    if (
      !findStable ||
      !conversationFindIndex.query ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const attemptKey = `${conversationFindIndex.query}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
    if (lastFindAutoLoadAttemptRef.current === attemptKey) {
      return;
    }
    lastFindAutoLoadAttemptRef.current = attemptKey;
    void onLoadOlder?.();
  }, [canLoadOlder, conversationFindIndex.query, findStable, loadingOlder, onLoadOlder, rows]);

  useEffect(() => {
    if (!conversationFindIndex.query || !activeFindMatch) {
      return;
    }
    const scrollKey = `${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
    if (lastFindScrollKeyRef.current === scrollKey) {
      return;
    }
    lastFindScrollKeyRef.current = scrollKey;
    scrollToUnit(activeFindMatch.unitIndex);
  }, [activeFindMatch, conversationFindIndex.query, scrollToUnit]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationFindIndex.query) {
      clearConversationFindHighlights();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const activeRange = applyConversationFindHighlights({
        root,
        query: conversationFindQuery,
        matches: conversationFindIndex.matches,
        activeMatch: activeFindMatch,
      });
      const highlightScrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch?.rowId ?? "none"}:${activeFindMatch?.rowMatchIndex ?? -1}:${activeFindMatch?.unitIndex ?? -1}`;
      if (activeRange && lastFindHighlightScrollKeyRef.current !== highlightScrollKey) {
        lastFindHighlightScrollKeyRef.current = highlightScrollKey;
        scrollConversationFindRangeIntoView(activeRange);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFindMatch,
    conversationFindIndex,
    conversationFindQuery,
    conversationFindNavigationRequestId,
    mountedRowsKey,
    rootRef,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (
      !request ||
      !findStable ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const snippet = request.snippet?.trim();
    const shouldLoadMore = snippet
      ? !searchResultFindIndex.matches.some((match) =>
          sourceTextContainsSnippet(match.sourceText, snippet),
        )
      : searchResultFindIndex.matchCount === 0;
    if (shouldLoadMore) {
      const attemptKey = `${request.requestId}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
      if (lastSearchResultAutoLoadAttemptRef.current === attemptKey) {
        return;
      }
      lastSearchResultAutoLoadAttemptRef.current = attemptKey;
      void onLoadOlder?.();
    }
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (!request || !findStable) {
      clearSearchResultHighlight();
      searchResultAppliedRequestRef.current = null;
      searchResultScrollRequestRef.current = null;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      return;
    }

    const match = resolveSearchResultHighlightMatch(searchResultFindIndex, request);
    const snippet = request.snippet?.trim();
    const snippetFound = snippet
      ? searchResultFindIndex.matches.some((candidate) =>
          sourceTextContainsSnippet(candidate.sourceText, snippet),
        )
      : true;
    const canStillLoad = canLoadOlder && rows.length < FIND_AUTO_LOAD_ROW_LIMIT && !loadingOlder;
    if (snippet && !snippetFound && (canStillLoad || loadingOlder)) {
      return;
    }
    if (!match) {
      if (!canStillLoad) {
        onSearchResultHighlightDone?.(request.requestId);
      }
      return;
    }

    if (searchResultScrollRequestRef.current !== request.requestId) {
      searchResultScrollRequestRef.current = request.requestId;
      scrollToUnit(match.unitIndex);
    }

    if (searchResultAppliedRequestRef.current === request.requestId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const range = applySearchResultHighlight({
        root,
        query: request.query,
        match,
      });
      if (!range) {
        return;
      }
      searchResultAppliedRequestRef.current = request.requestId;
      scrollConversationFindRangeIntoView(range);
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
      searchResultCleanupTimerRef.current = window.setTimeout(() => {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        searchResultCleanupTimerRef.current = undefined;
      }, SEARCH_RESULT_HIGHLIGHT_DURATION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    mountedRowsKey,
    onSearchResultHighlightDone,
    rootRef,
    rows,
    scrollToUnit,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    return () => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
    };
  }, []);
}
