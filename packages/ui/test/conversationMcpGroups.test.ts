import { describe, expect, it } from "vitest";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import * as presentation from "@/v4/conversation-presentation/index.js";
import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";

const mcp = (
  rowId: number,
  serverName = "alpha",
  extra: Partial<ToolCallRow> = {},
): ToolCallRow => ({
  kind: "toolCall",
  rowId,
  turnId: "turn",
  createdAt: rowId,
  createdAtSeq: rowId,
  toolCallId: `call-${rowId}`,
  toolName: `mcp__${serverName}__lookup`,
  status: "success",
  inputText: "{}",
  display: { kind: "mcp_tool", serverName, toolName: "lookup" },
  ...extra,
});
const group = (rows: readonly ConversationRow[]) => presentation.buildConversationMcpGroups(rows);

it("UX06 canonical MCP in-band 标记派生组失败，覆盖旧顶层 display，不读错误文案", () => {
  const row = mcp(501, "alpha", {
    output: {
      text: "opaque failure",
      display: { kind: "mcp_tool", serverName: "alpha", toolName: "call", isError: true },
    },
  });
  expect(presentation.isConversationMcpRowFailure(row)).toBe(true);
  expect(
    buildAssistantWorkRenderItems([mcp(500), row], { messageStreamShowReasoning: false })[0],
  ).toMatchObject({ kind: "mcpGroup", node: { toolCall: { status: "failed" } } });
  expect(
    presentation.isConversationMcpRowFailure(
      mcp(502, "alpha", { output: { text: "MCP tool returned an error: boom" } }),
    ),
  ).toBe(false);
});

describe("连续 MCP 服务投影", () => {
  it("A→A 合组且保留真实调用与原生父调用身份", () => {
    const rows = [
      mcp(1, "alpha", { parentToolCallId: "native" }),
      mcp(2, "alpha", { parentToolCallId: "native" }),
    ];
    expect(group(rows)).toEqual([{ kind: "mcpGroup", serverName: "alpha", rows }]);
    expect(rows.map((row) => [row.toolCallId, row.parentToolCallId])).toEqual([
      ["call-1", "native"],
      ["call-2", "native"],
    ]);
  });
  it("A→B→A 三组，不按服务全局重排", () => {
    expect(
      group([mcp(1), mcp(2, "beta"), mcp(3)]).map((item) =>
        item.kind === "mcpGroup" ? item.serverName : "row",
      ),
    ).toEqual(["alpha", "beta", "alpha"]);
  });
  it("legacy 同短名不同完整服务保持 A→A / B / A 身份边界", () => {
    const rows = [
      mcp(701, "unused", {
        display: undefined,
        toolName: "mcp__plugin_one_alpha__alpha_lookup",
      }),
      mcp(702, "unused", {
        display: undefined,
        toolName: "mcp__plugin_one_alpha__alpha_list",
      }),
      mcp(703, "unused", {
        display: undefined,
        toolName: "mcp__plugin_two_alpha__alpha_lookup",
      }),
      mcp(704, "unused", {
        display: undefined,
        toolName: "mcp__plugin_one_alpha__alpha_lookup",
      }),
    ];
    expect(group(rows)).toEqual([
      { kind: "mcpGroup", serverName: "alpha", rows: [rows[0], rows[1]] },
      { kind: "mcpGroup", serverName: "alpha", rows: [rows[2]] },
      { kind: "mcpGroup", serverName: "alpha", rows: [rows[3]] },
    ]);
  });
  it("legacy 与 discovery 不凭相同短名推断同一服务，同源连续调用仍合组", () => {
    const rows = [
      mcp(711, "alpha", { display: undefined }),
      mcp(712, "alpha", { display: undefined }),
      mcp(713, "alpha"),
      mcp(714, "alpha"),
      mcp(715, "alpha", { display: undefined }),
    ];
    expect(group(rows)).toEqual([
      { kind: "mcpGroup", serverName: "alpha", rows: [rows[0], rows[1]] },
      { kind: "mcpGroup", serverName: "alpha", rows: [rows[2], rows[3]] },
      { kind: "mcpGroup", serverName: "alpha", rows: [rows[4]] },
    ]);
  });
  it("discovery 保留完整配置服务键，canonical metadata 优先且 A→B→A 不重排", () => {
    const rows = [
      mcp(721, "plugin:one:alpha"),
      mcp(722, "alpha", {
        output: {
          display: {
            kind: "mcp_tool",
            serverName: "plugin:one:alpha",
            toolName: "lookup",
          },
        },
      }),
      mcp(723, "plugin:two:alpha"),
      mcp(724, "plugin:one:alpha"),
    ];
    expect(group(rows)).toEqual([
      { kind: "mcpGroup", serverName: "plugin:one:alpha", rows: [rows[0], rows[1]] },
      { kind: "mcpGroup", serverName: "plugin:two:alpha", rows: [rows[2]] },
      { kind: "mcpGroup", serverName: "plugin:one:alpha", rows: [rows[3]] },
    ]);
  });
  it.each([
    {
      kind: "assistantText",
      rowId: 2,
      turnId: "turn",
      createdAt: 2,
      createdAtSeq: 2,
      text: "正文",
      textVersion: 1,
      streaming: false,
    },
    {
      kind: "assistantText",
      rowId: 2,
      turnId: "turn",
      createdAt: 2,
      createdAtSeq: 2,
      text: "",
      textVersion: 1,
      streaming: false,
      media: [{ mediaType: "image", source: "https://example.invalid/result.png" }],
    },
  ] as ConversationRow[])("正文及空正文媒体均截断连续组", (boundary) => {
    const projected = group([mcp(1), boundary, mcp(3)]);
    expect(projected.map((item) => item.kind)).toEqual(["mcpGroup", "row", "mcpGroup"]);
    expect(projected[1]).toEqual({ kind: "row", row: boundary });
  });
  it("缺 metadata 历史仅显式 MCP envelope 回退", () => {
    const legacy = mcp(1, "alpha", { display: undefined });
    const unknown = mcp(2, "alpha", { display: undefined, toolName: "unknown" });
    expect(group([legacy, unknown])).toEqual([
      { kind: "mcpGroup", serverName: "alpha", rows: [legacy] },
      { kind: "row", row: unknown },
    ]);
  });
  it("不同 turn/原生 parent 截断，Node REPL/插件/CUA 保持专用展示", () => {
    const rows = [
      mcp(1),
      mcp(2, "alpha", { turnId: "other" }),
      mcp(3, "alpha", { parentToolCallId: "parent" }),
      mcp(4, "node_repl", { toolName: "mcp__node_repl__js" }),
      mcp(5, "alpha", {
        display: {
          kind: "mcp_tool",
          serverName: "alpha",
          toolName: "lookup",
          ui: { resourceUri: "ui://example/view" },
        },
      }),
      mcp(6, "alpha", {
        output: {
          text: "screen",
          display: {
            kind: "cua",
            schemaVersion: 1,
            toolName: "computer-use",
            status: "success",
            media: [],
          },
        },
      }),
    ];
    expect(group(rows).map((item) => item.kind)).toEqual([
      "mcpGroup",
      "mcpGroup",
      "mcpGroup",
      "row",
      "row",
      "row",
    ]);
  });
  it("实际工作项消费连续组，children 仍保留原始 toolCallId", () => {
    const items = buildAssistantWorkRenderItems([mcp(1), mcp(2)], {
      messageStreamShowReasoning: false,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "mcpGroup",
      node: {
        childToolCalls: [{ toolCall: { toolId: "call-1" } }, { toolCall: { toolId: "call-2" } }],
      },
    });
  });
  it("终态服务组保留真实取消状态，不把已停止子调用汇总为完成", () => {
    const item = buildAssistantWorkRenderItems(
      [mcp(601), mcp(602, "alpha", { status: "cancelled" })],
      {
        messageStreamShowReasoning: false,
      },
    )[0];
    expect(item).toMatchObject({ kind: "mcpGroup", node: { toolCall: { status: "stopped" } } });
  });
});

it("运行中的 CUA 即使尚无结果也不被通用服务分组接管", () => {
  const row = mcp(77, "computer-use", {
    toolName: "mcp__computer-use__left_click",
    status: "running",
  });
  expect(group([row])).toEqual([{ kind: "row", row }]);
});
it("完整 scope 键隔离远端、会话、epoch、turn，workspace identity 优先", () => {
  const scope = {
    workspacePath: "/same",
    workspaceIdentity: "remote:one",
    workspaceRemoteSessionId: "remote-1",
    sessionId: "session-1",
    logEpoch: "epoch-1",
  };
  const keys = presentation.resolveConversationDisclosureKeys(scope, "turn-1", "mcpTool", [
    "call-1",
  ]);
  expect(
    presentation.resolveConversationDisclosureKeys(
      { ...scope, workspacePath: "/changed" },
      "turn-1",
      "mcpTool",
      ["call-1"],
    ),
  ).toEqual(keys);
  for (const changed of [
    { workspaceIdentity: "remote:two" },
    { workspaceRemoteSessionId: "remote-2" },
    { sessionId: "session-2" },
    { logEpoch: "epoch-2" },
  ])
    expect(
      presentation.resolveConversationDisclosureKeys(
        { ...scope, ...changed },
        "turn-1",
        "mcpTool",
        ["call-1"],
      ),
    ).not.toEqual(keys);
  expect(
    presentation.resolveConversationDisclosureKeys(scope, "turn-2", "mcpTool", ["call-1"]),
  ).not.toEqual(keys);
  expect(
    presentation.resolveConversationDisclosureKeys(scope, "turn-1", "mcpGroup", ["call-1"]),
  ).not.toEqual(keys);
});

it("legacy 仅接受三个 envelope 段，并复用机械插件服务短名", () => {
  const plugin = mcp(401, "unused", {
    display: undefined,
    toolName: "mcp__plugin_firebase_firebase__firebase_get_environment",
  });
  const malformed = mcp(402, "unused", {
    display: undefined,
    toolName: "mcp__alpha__lookup__extra",
  });
  expect(group([plugin, malformed])).toEqual([
    { kind: "mcpGroup", serverName: "firebase", rows: [plugin] },
    { kind: "row", row: malformed },
  ]);
});
