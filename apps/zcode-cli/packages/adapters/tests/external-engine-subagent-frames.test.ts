import { describe, expect, test } from "vitest";
import {
  fallbackSubagentName,
  readSubagentFrame,
  type KnownSubagent,
} from "../src/external-engine/subagent-frames.js";

// 帧形状来自 codex-acp 2.2.2 CodexSubagentEventRouter 与 claude-agent-acp 0.95.0 native-subagents.js。
const MAIN = "root-session";
const none = new Map<string, KnownSubagent>();
const known = (...ids: string[]) => new Map(ids.map((id) => [id, { cancellable: false }]));

describe("AIR 草案形态（Codex）", () => {
  test("subagent_spawned 归一为 spawned；空 capabilities 不可取消；嵌套记录直接父会话", () => {
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: "thread-1",
          name: "Engine perf auth",
          task: "检查耗时",
          capabilities: {},
        },
        none,
      ),
    ).toEqual({
      events: [
        {
          type: "spawned",
          nativeSessionId: "thread-1",
          name: "Engine perf auth",
          task: "检查耗时",
          cancellable: false,
        },
      ],
    });
    expect(
      readSubagentFrame(
        "thread-1",
        MAIN,
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: "thread-2",
          name: "",
          task: "t",
          prompt: "精确提示",
          capabilities: { cancel: true },
        },
        known("thread-1"),
      ),
    ).toEqual({
      events: [
        expect.objectContaining({
          parentNativeSessionId: "thread-1",
          name: fallbackSubagentName("thread-2"),
          prompt: "精确提示",
          cancellable: true,
        }),
      ],
    });
  });

  test("重复宣告幂等；state 映射 disconnected→lost；未知子会话与非法值判为无效", () => {
    const spawned = {
      sessionUpdate: "subagent_spawned",
      subagentSessionId: "thread-1",
      name: "A",
      capabilities: {},
    };
    expect(readSubagentFrame(MAIN, MAIN, spawned, known("thread-1"))).toEqual({ events: [] });
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        { sessionUpdate: "subagent_state_update", subagentSessionId: "thread-1", state: "disconnected" },
        known("thread-1"),
      ),
    ).toEqual({ events: [{ type: "state", nativeSessionId: "thread-1", state: "lost" }] });
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        { sessionUpdate: "subagent_state_update", subagentSessionId: "thread-9", state: "completed" },
        none,
      ),
    ).toEqual({ invalid: "subagent_state_unknown" });
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        { sessionUpdate: "subagent_state_update", subagentSessionId: "thread-1", state: "weird" },
        known("thread-1"),
      ),
    ).toEqual({ invalid: "subagent_state_update" });
    expect(
      readSubagentFrame(MAIN, MAIN, { sessionUpdate: "subagent_spawned", subagentSessionId: MAIN }, none),
    ).toEqual({ invalid: "subagent_spawned" });
  });
});

describe("RFD 形态（Claude）", () => {
  test("首条 subagent_update 宣告子会话：标题、描述、cancel 对象与待到达的提示", () => {
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        {
          sessionUpdate: "subagent_update",
          sessionId: "agent-1",
          title: "Explorer (Explore)",
          description: "Find auth code",
          capabilities: { cancel: {} },
          state: { state: "running" },
        },
        none,
      ),
    ).toEqual({
      events: [
        {
          type: "spawned",
          nativeSessionId: "agent-1",
          name: "Explorer (Explore)",
          task: "Find auth code",
          cancellable: true,
          promptPending: true,
        },
      ],
    });
    // capabilities:null 清空可变操作 → 不可取消。
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        { sessionUpdate: "subagent_update", sessionId: "agent-2", capabilities: null },
        none,
      ),
    ).toEqual({ events: [expect.objectContaining({ cancellable: false, name: fallbackSubagentName("agent-2") })] });
  });

  test.each([
    [{ state: "requires_action" }, { state: "waiting" }],
    [{ state: "idle", stopReason: "end_turn" }, { state: "completed" }],
    [{ state: "idle", stopReason: "cancelled" }, { state: "cancelled" }],
    [
      { state: "idle", stopReason: "error", error: { code: -32603, message: "boom" } },
      { state: "failed", error: "boom" },
    ],
    [{ state: "idle" }, { state: "lost" }],
    [{ state: "unknown" }, { state: "lost" }],
  ])("state %j → %j", (state, expected) => {
    expect(
      readSubagentFrame(MAIN, MAIN, { sessionUpdate: "subagent_update", sessionId: "agent-1", state }, known("agent-1")),
    ).toEqual({ events: [{ type: "state", nativeSessionId: "agent-1", ...expected }] });
  });

  test("session_message：子会话接收视图为提示，父会话收到的子会话发言为回答，父发送视图忽略", () => {
    const message = {
      sessionUpdate: "session_message",
      messageId: "toolu_1",
      senderSessionId: MAIN,
      recipientSessionId: "agent-1",
      content: [{ type: "text", text: "找鉴权" }],
    };
    expect(readSubagentFrame(MAIN, MAIN, message, known("agent-1"))).toEqual({ events: [] });
    expect(readSubagentFrame("agent-1", MAIN, message, known("agent-1"))).toEqual({
      events: [{ type: "prompt", nativeSessionId: "agent-1", messageId: "toolu_1", text: "找鉴权" }],
    });
    expect(
      readSubagentFrame(
        MAIN,
        MAIN,
        {
          sessionUpdate: "session_message",
          messageId: "toolu_1:reply",
          senderSessionId: "agent-1",
          recipientSessionId: MAIN,
          content: [{ type: "text", text: "在 auth.ts" }],
        },
        known("agent-1"),
      ),
    ).toEqual({ events: [{ type: "reply", nativeSessionId: "agent-1", text: "在 auth.ts" }] });
  });
});
