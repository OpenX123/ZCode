import type { ExternalEngineSubagentEvent, ExternalEngineSubagentState } from "@zcode/contracts";

/**
 * 原生子智能体帧的边界归一（只读两家 adapter 的真实形状，见根仓
 * docs/desktop/external-agent-engines-spec.md「外部引擎原生子智能体」）：
 * - AIR 草案（Codex 2.2.2）：`subagent_spawned` / `subagent_state_update`。
 * - RFD（Claude 0.95.0，未声明 AIR）：`subagent_update` / `session_message`。
 * 这里不做 IO，也不持有状态；子会话归属表由 connection 持有并传入只读视图。
 */
type JsonObject = Record<string, unknown>;

export const SUBAGENT_FRAME_KINDS = new Set([
  "subagent_spawned",
  "subagent_state_update",
  "subagent_update",
  "session_message",
  "session_message_chunk",
]);

export interface KnownSubagent {
  cancellable: boolean;
}

/** 无效帧不判定连接故障（协议仍是 unstable）；调用方记 debug 后丢弃。 */
export type SubagentFrameResult =
  | { events: ExternalEngineSubagentEvent[] }
  | { invalid: string };

const FALLBACK_NAME_SUFFIX_LENGTH = 8;
const AIR_STATES: Record<string, ExternalEngineSubagentState> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  // 原生已无法观察该子会话（load 收尾或断联）。
  disconnected: "lost",
};

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 与 codex-acp fallbackName 一致：`Agent <末 8 位>`。 */
export function fallbackSubagentName(nativeSessionId: string): string {
  return `Agent ${nativeSessionId.slice(-FALLBACK_NAME_SUFFIX_LENGTH)}`;
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
  return parts.length ? parts.join("\n\n") : undefined;
}

/** RFD 的 state 快照 → YCode 状态；`null`/缺省表示不变。 */
function rfdState(
  value: unknown,
): { state: ExternalEngineSubagentState; error?: string } | undefined {
  const state = record(value);
  if (!state) return undefined;
  switch (state.state) {
    case "running":
      return { state: "running" };
    case "requires_action":
      return { state: "waiting" };
    case "idle": {
      if (state.stopReason === "end_turn") return { state: "completed" };
      if (state.stopReason === "cancelled") return { state: "cancelled" };
      if (state.stopReason === "error") {
        const error = text(record(state.error)?.message);
        return { state: "failed", ...(error ? { error } : {}) };
      }
      // 无 stopReason 的 idle：工作结束但 adapter 未观察到原因（流结束/worker 重启）。
      return { state: "lost" };
    }
    case "unknown":
      return { state: "lost" };
    default:
      return undefined;
  }
}

/**
 * frameSessionId 是帧所在的原生会话（主会话或已宣告子会话）；返回需要交付的归一事件。
 * spawned 事件由调用方登记进 known 后，后续帧才会被路由。
 */
export function readSubagentFrame(
  frameSessionId: string,
  mainSessionId: string,
  update: JsonObject,
  known: ReadonlyMap<string, KnownSubagent>,
): SubagentFrameResult {
  const parentNativeSessionId = frameSessionId === mainSessionId ? undefined : frameSessionId;
  switch (update.sessionUpdate) {
    case "subagent_spawned": {
      const id = text(update.subagentSessionId);
      if (!id || id === mainSessionId) return { invalid: "subagent_spawned" };
      if (known.has(id)) return { events: [] };
      const capabilities = record(update.capabilities);
      const task = text(update.task);
      const prompt = text(update.prompt);
      return {
        events: [
          {
            type: "spawned",
            nativeSessionId: id,
            ...(parentNativeSessionId ? { parentNativeSessionId } : {}),
            name: text(update.name) ?? fallbackSubagentName(id),
            ...(task ? { task } : {}),
            ...(prompt ? { prompt } : {}),
            cancellable: capabilities?.cancel === true,
          },
        ],
      };
    }
    case "subagent_state_update": {
      const id = text(update.subagentSessionId);
      const state = AIR_STATES[String(update.state)];
      if (!id || !state) return { invalid: "subagent_state_update" };
      return known.has(id)
        ? { events: [{ type: "state", nativeSessionId: id, state }] }
        : { invalid: "subagent_state_unknown" };
    }
    case "subagent_update": {
      const id = text(update.sessionId);
      if (!id || id === mainSessionId) return { invalid: "subagent_update" };
      const state = rfdState(update.state);
      const events: ExternalEngineSubagentEvent[] = [];
      if (!known.has(id)) {
        const title = text(update.title);
        const description = text(update.description);
        events.push({
          type: "spawned",
          nativeSessionId: id,
          ...(parentNativeSessionId ? { parentNativeSessionId } : {}),
          name: title ?? description ?? fallbackSubagentName(id),
          ...(description ? { task: description } : {}),
          // RFD 以对象授予 cancel（`capabilities: {cancel: {}}`）；null/缺省表示无可变操作。
          cancellable: record(record(update.capabilities)?.cancel) !== undefined,
          promptPending: true,
        });
        if (state && state.state !== "running") events.push({ type: "state", nativeSessionId: id, ...state });
        return { events };
      }
      return state ? { events: [{ type: "state", nativeSessionId: id, ...state }] } : { events: [] };
    }
    case "session_message": {
      const body = contentText(update.content);
      const messageId = text(update.messageId);
      if (!body || !messageId) return { events: [] };
      const sender = text(update.senderSessionId);
      const recipient = text(update.recipientSessionId);
      // 子会话的接收视图：委派提示是子会话首条 user 消息。
      if (parentNativeSessionId && recipient === frameSessionId && sender !== frameSessionId)
        return { events: [{ type: "prompt", nativeSessionId: frameSessionId, messageId, text: body }] };
      // 父会话收到子会话的回答；父会话自己的发送视图不入子会话正文。
      if (sender && sender !== frameSessionId && known.has(sender))
        return { events: [{ type: "reply", nativeSessionId: sender, text: body }] };
      return { events: [] };
    }
    default:
      return { events: [] };
  }
}
