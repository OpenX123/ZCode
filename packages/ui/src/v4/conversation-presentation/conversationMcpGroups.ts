import { getZCodeToolFamilyForName } from "@zcode/shared";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationMcpGroupItem,
  ConversationDisclosureScope,
  McpToolPresentation,
} from "./contract.js";

/** 专用工具和插件交互不能被普通 MCP 服务容器认领。 */
export function readConversationMcpServer(row: ConversationRow): string | undefined {
  if (
    row.kind !== "toolCall" ||
    getZCodeToolFamilyForName(row.toolName) ||
    row.toolName.toLowerCase().replaceAll("_", "-").includes("computer-use")
  )
    return undefined;
  const display = row.output?.display ?? row.display;
  if (display && display.kind !== "mcp_tool") return undefined;
  if (display?.kind === "mcp_tool") {
    if (display.ui || !display.serverName.trim() || !display.toolName.trim()) return undefined;
    return display.serverName;
  }
  return readLegacyMcpToolPresentation(row.toolName)?.serverName;
}

function readConversationMcpServerIdentity(row: ToolCallRow): string {
  const display = row.output?.display ?? row.display;
  // 展示短名可能碰撞；仅处理已识别的 MCP 行，保留完整服务键。
  // legacy 无法无损还原 discovery 配置键，两种来源不能凭短名推断同一。
  return JSON.stringify(
    display?.kind === "mcp_tool"
      ? ["discovery", display.serverName]
      : ["legacy", row.toolName.split("__")[1]],
  );
}

export function buildConversationMcpGroups(
  rows: readonly ConversationRow[],
): readonly ConversationMcpGroupItem[] {
  const items: ConversationMcpGroupItem[] = [];
  for (const row of rows) {
    const serverName = readConversationMcpServer(row);
    if (!serverName || row.kind !== "toolCall") {
      items.push({ kind: "row", row });
      continue;
    }
    const previous = items.at(-1);
    const anchor = previous?.kind === "mcpGroup" ? previous.rows[0] : undefined;
    if (
      previous?.kind === "mcpGroup" &&
      anchor &&
      readConversationMcpServerIdentity(anchor) === readConversationMcpServerIdentity(row) &&
      anchor.turnId === row.turnId &&
      anchor.parentToolCallId === row.parentToolCallId
    ) {
      items[items.length - 1] = { ...previous, rows: [...previous.rows, row] };
    } else items.push({ kind: "mcpGroup", serverName, rows: [row] });
  }
  return items;
}

/** JSON 元组避免分隔符碰撞；状态只按完整展示身份隔离，不缓存生命周期。 */
export function resolveConversationDisclosureKeys(
  scope: ConversationDisclosureScope,
  turnId: string,
  kind: string,
  toolCallIds: readonly string[],
): readonly string[] {
  return toolCallIds.map((id) =>
    JSON.stringify([
      scope.workspaceIdentity?.trim() || scope.workspacePath,
      scope.workspaceRemoteSessionId ?? null,
      scope.sessionId ?? null,
      scope.logEpoch ?? null,
      turnId,
      kind,
      id,
    ]),
  );
}

export function isConversationMcpRowFailure(row: ToolCallRow): boolean {
  const display = row.output?.display ?? row.display;
  return (
    row.status === "error" ||
    (display?.kind === "mcp_tool" && (display.isError === true || display.ui?.isError === true)) ||
    /<tool_use_error>[\s\S]*<\/tool_use_error>/iu.test(row.output?.text ?? "")
  );
}

export function readLegacyMcpToolPresentation(
  toolName: string | undefined,
): McpToolPresentation | null {
  if (!toolName) return null;
  const segments = toolName.split("__");
  if (segments.length !== 3 || segments[0] !== "mcp" || !segments[1] || !segments[2]) return null;

  const encodedServerName = segments[1];
  const encodedToolName = segments[2];
  const serverTokens = encodedServerName.split("_").filter(Boolean);
  const toolTokens = encodedToolName.split("_").filter(Boolean);
  let sharedTokenCount = 0;
  const maximumSharedTokens = Math.min(serverTokens.length, toolTokens.length);
  for (let tokenCount = maximumSharedTokens; tokenCount > 0; tokenCount -= 1) {
    if (
      serverTokens.slice(-tokenCount).join("_").toLocaleLowerCase() ===
      toolTokens.slice(0, tokenCount).join("_").toLocaleLowerCase()
    ) {
      sharedTokenCount = tokenCount;
      break;
    }
  }
  const pluginScoped = serverTokens[0]?.toLocaleLowerCase() === "plugin";
  const serverName =
    sharedTokenCount > 0
      ? serverTokens.slice(-sharedTokenCount).join("_")
      : pluginScoped
        ? serverTokens.at(-1)!
        : encodedServerName;
  const actionName =
    sharedTokenCount > 0 && sharedTokenCount < toolTokens.length
      ? toolTokens.slice(sharedTokenCount).join("_")
      : encodedToolName;

  // display 持久化上线前的 MCP 历史记录只剩协议执行名，通用 renderer
  // 会把内部 raw JSON 整块暴露出来。这里只按协议 envelope 和编码 token 做机械拆分；
  // 新记录仍以 tools/list 的 discovery display 为权威，不让 legacy 规则覆盖它。
  return { kind: "mcp_tool", serverName, toolName: actionName };
}
