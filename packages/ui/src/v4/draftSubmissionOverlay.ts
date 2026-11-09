import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttachmentRef,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 草稿首发的 pending optimistic overlay（docs/desktop/engine-performance-1.1-spec.md
 * 「草稿首发的即时会话布局」）。
 *
 * 只是 Renderer 展示层：不写 projection store、不进 snapshot、不参与发送屏障。真实行永远来自
 * CLI 投影；以 sendText 信封的 commandId 与真实行 sourceCommandId 去重。
 */
export interface DraftSubmissionOverlay {
  /** 本次点击的本地身份；迟到的回调只能操作同一次提交。 */
  localId: string;
  /** 与 sendText 正文一致，行渲染按同一规则解析上下文尾块。 */
  text: string;
  attachments?: readonly AttachmentRef[];
  /** 点击发送时刻（telemetrySeed.sendTime），「工作中 N 秒」从这里计时。 */
  startedAt: number;
  /** sendText 信封 commandId；真实行 sourceCommandId 与之相同即收口。 */
  commandId: string | null;
  /** promotion commit 时绑定的新会话 id；pane 切到别的会话时据此丢弃。 */
  boundSessionId: string | null;
  status: "pending" | "failed";
  failure?: { code: string; summary: string };
}

// overlay 行排在任何真实行之后（rowId 在 session 内单调递增，真实值远小于此）。
const OVERLAY_HEADER_ROW_ID = Number.MAX_SAFE_INTEGER - 1;
const OVERLAY_USER_ROW_ID = Number.MAX_SAFE_INTEGER;

export function buildDraftSubmissionOverlayRows(
  overlay: DraftSubmissionOverlay,
): ConversationRow[] {
  const turnId = `draft-submission:${overlay.localId}`;
  const header: TurnHeaderRow = {
    rowId: OVERLAY_HEADER_ROW_ID,
    turnId,
    createdAt: overlay.startedAt,
    createdAtSeq: OVERLAY_HEADER_ROW_ID,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: overlay.status === "failed" ? "failed" : "running",
    startedAt: overlay.startedAt,
    ...(overlay.status === "failed" && overlay.failure
      ? { failure: { ...overlay.failure, source: "runtime" as const } }
      : {}),
  };
  const userInput: UserInputRow = {
    rowId: OVERLAY_USER_ROW_ID,
    turnId,
    createdAt: overlay.startedAt,
    createdAtSeq: OVERLAY_USER_ROW_ID,
    kind: "userInput",
    origin: "realUser",
    text: overlay.text,
    ...(overlay.attachments?.length ? { attachments: [...overlay.attachments] } : {}),
  };
  return [header, userInput];
}

export function isDraftSubmissionOverlaySettled(
  rows: readonly ConversationRow[],
  overlay: DraftSubmissionOverlay,
): boolean {
  const commandId = overlay.commandId;
  if (!commandId) return false;
  return rows.some(
    (row) =>
      (row.kind === "userInput" || row.kind === "turnHeader") && row.sourceCommandId === commandId,
  );
}

export function mergeDraftSubmissionOverlayRows(
  rows: readonly ConversationRow[],
  overlay: DraftSubmissionOverlay | null,
): readonly ConversationRow[] {
  if (!overlay || isDraftSubmissionOverlaySettled(rows, overlay)) return rows;
  return [...rows, ...buildDraftSubmissionOverlayRows(overlay)];
}

export interface DraftSubmissionOverlayController {
  /** 当前 pane 可见的 overlay；切到其它会话后为 null。 */
  overlay: DraftSubmissionOverlay | null;
  begin(input: { text: string; attachments?: readonly AttachmentRef[]; startedAt: number }): string;
  attachCommand(localId: string, commandId: string): void;
  /** promotion commit 同步调用：把在途 overlay 绑定到新会话。 */
  bindSession(sessionId: string): void;
  /** 发送 accepted：拿不到 commandId（非 sendText 命令）时无法去重，直接移除。 */
  settleAccepted(localId: string): void;
  fail(localId: string, failure: { code: string; summary: string }): void;
  clear(localId: string): void;
  /** 真实行出现同一 sourceCommandId 后移除（渲染层已先行去重，这里只回收状态）。 */
  reconcile(rows: readonly ConversationRow[]): void;
}

let overlaySequence = 0;

export function useDraftSubmissionOverlay({
  sessionId,
  resetKey,
}: {
  sessionId: string | null;
  /** 工作区 + 草稿 scope；变化即丢弃旧 overlay。 */
  resetKey: string;
}): DraftSubmissionOverlayController {
  const [state, setState] = useState<DraftSubmissionOverlay | null>(null);
  const update = useCallback(
    (localId: string, next: (current: DraftSubmissionOverlay) => DraftSubmissionOverlay | null) => {
      setState((current) => (current?.localId === localId ? next(current) : current));
    },
    [],
  );
  const begin = useCallback<DraftSubmissionOverlayController["begin"]>((input) => {
    overlaySequence += 1;
    const localId = `${Date.now().toString(36)}-${overlaySequence}`;
    setState({
      localId,
      text: input.text,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      startedAt: input.startedAt,
      commandId: null,
      boundSessionId: null,
      status: "pending",
    });
    return localId;
  }, []);
  const attachCommand = useCallback(
    (localId: string, commandId: string) =>
      update(localId, (current) => ({ ...current, commandId })),
    [update],
  );
  const bindSession = useCallback((boundSessionId: string) => {
    setState((current) =>
      current && current.status === "pending" && current.boundSessionId === null
        ? { ...current, boundSessionId }
        : current,
    );
  }, []);
  const settleAccepted = useCallback(
    (localId: string) => update(localId, (current) => (current.commandId ? current : null)),
    [update],
  );
  const fail = useCallback(
    (localId: string, failure: { code: string; summary: string }) =>
      update(localId, (current) => ({ ...current, status: "failed", failure })),
    [update],
  );
  const clear = useCallback((localId: string) => update(localId, () => null), [update]);
  const reconcile = useCallback((rows: readonly ConversationRow[]) => {
    setState((current) =>
      current && isDraftSubmissionOverlaySettled(rows, current) ? null : current,
    );
  }, []);

  // 工作区或草稿 scope 变化：旧 overlay 不属于新 pane 内容。
  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    setState(null);
  }, [resetKey]);
  // pane 切到不是本次 promotion 的会话（用户在发送途中离开）：直接丢弃。
  useEffect(() => {
    if (sessionId === null) return;
    setState((current) => (current && current.boundSessionId !== sessionId ? null : current));
  }, [sessionId]);

  const overlay =
    state && (sessionId === null || state.boundSessionId === sessionId) ? state : null;
  return useMemo(
    () => ({
      overlay,
      begin,
      attachCommand,
      bindSession,
      settleAccepted,
      fail,
      clear,
      reconcile,
    }),
    [overlay, begin, attachCommand, bindSession, settleAccepted, fail, clear, reconcile],
  );
}
