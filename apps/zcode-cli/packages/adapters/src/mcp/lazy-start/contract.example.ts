/**
 * cli-mcp-lazy-start 标准调用示例：会话 lease 登记 server、首次使用时启动、连接完成后计闲置窗口。
 */
import type { McpServerConfig, McpToolCallResult } from "@zcode/contracts";
import type { McpLeaseServerLifecycle, McpLeaseServerLifecycleDeps } from "./contract.js";

export async function exampleLeaseUse(input: {
  createLifecycle: (deps: McpLeaseServerLifecycleDeps) => McpLeaseServerLifecycle;
  deps: McpLeaseServerLifecycleDeps;
  servers: Array<[string, McpServerConfig]>;
  callTool: (serverName: string) => Promise<McpToolCallResult>;
}): Promise<McpToolCallResult | undefined> {
  const lifecycle = input.createLifecycle(input.deps);
  // 只等缓存读取：命中的 server 推迟到首次使用，未命中的在后台连接。
  await lifecycle.register(input.servers, {});
  const [serverName] = input.servers[0] ?? [];
  if (!serverName) return undefined;
  // 首次使用时单飞连接；使用期间暂停闲置计时，结束后重新计时。
  const result = await lifecycle.use(serverName, "tool_call", () => input.callTool(serverName));
  // 会话关闭：结束首次连接等待、清除计时器，再由 lease 释放连接。
  lifecycle.close();
  return result;
}
