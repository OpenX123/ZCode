/**
 * mobile-remote-gateway 标准装配：由 Main 注入窗口列表与 attach 端口。
 */
import type { MobileRemoteGatewayDependencies } from "./contract.js";

export const mobileRemoteGatewayDependenciesExample: Omit<MobileRemoteGatewayDependencies, "store"> = {
  hostName: () => "My Mac",
  listWindows: () => [{ windowId: 1, title: "ZCode", focused: true, workspacePath: "/Users/me/ZCode" }],
  attachWindow: () => null,
  logger: { info: () => {}, warn: () => {} },
};
