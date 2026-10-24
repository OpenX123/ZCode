import {
  zcodeProviderRefreshRegistryParamsSchema,
  type ZCodeProviderRefreshRegistryResult,
} from "@zcode/shared";
import { ProtocolRequestError, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 让当前 Worker 重新读取自己的 本地 Personal Config Store。
 *
 * 该请求只触发 Worker 本地刷新，不接收 Desktop Registry 快照，避免把远端 Environment
 * 的 Provider 权威重新下沉到 Host。执行入口在 ACK 前调用它，封住 Provisioning 后存量
 * Worker 仍持有旧 Registry 的窗口。
 */
export async function refreshProviderRegistry(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderRefreshRegistryResult> {
  const envelope = zcodeProviderRefreshRegistryParamsSchema.parse(params);
  if (!context.deps.refreshProviderRegistry) {
    throw new ProtocolRequestError(-32019, "Provider Registry refresh is not configured");
  }
  await context.deps.refreshProviderRegistry(envelope.reason);
  return { refreshed: true };
}
