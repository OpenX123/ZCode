import type {
  OpenPluginUiSideTabRequest,
  PluginUiPresentation,
  PluginUiSidePaneTab,
} from "./contract.js";
import { buildPluginUiSidePaneTabId, readPluginUiScopeRef } from "./contract.js";
import type { ConversationRowsPartition } from "@zcode/shared/zcode-protocol-v4";
import { createLogicalUiInstancesSelector } from "./index.js";

/** 每个时间线保留一个选择器；普通尾轮文本更新可以复用历史插件裁决。 */
export const exampleSelectLogicalUiInstances = createLogicalUiInstancesSelector();
export const exampleConversationPartition: ConversationRowsPartition = { history: [], tail: [] };

export const examplePresentation: PluginUiPresentation = {
  serverName: "plugin:example-plugin:widget",
  pluginId: "example-plugin@example-marketplace",
  resourceUri: "ui://example-plugin/widget.html",
  preferredDisplayMode: "fullscreen",
  prefersBorder: true,
};

/** 内联卡片 / 面板入口请求打开侧栏时的载荷，以及据此创建的 tab。 */
export function exampleOpenSideTab(request: OpenPluginUiSideTabRequest): PluginUiSidePaneTab {
  const scope = readPluginUiScopeRef(request);
  if (!scope) throw new Error("request needs toolCallId or surfaceId");
  return {
    id: buildPluginUiSidePaneTabId(request),
    type: "plugin-ui",
    parentSessionId: request.parentSessionId,
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
    ...(request.surfaceId ? { surfaceId: request.surfaceId } : {}),
    ...(request.serverName ? { serverName: request.serverName } : {}),
    pluginId: request.pluginId,
    resourceUri: request.resourceUri,
    title: request.title,
    workspacePath: request.workspacePath,
    workspaceIdentity: request.workspaceIdentity,
    remoteSessionId: request.remoteSessionId ?? null,
  };
}
