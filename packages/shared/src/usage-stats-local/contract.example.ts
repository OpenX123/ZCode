/**
 * usage-stats-local-protocol 标准调用示例：RPC 两端都用 schema 校验请求与快照。
 */
import {
  localUsageRequestSchema,
  localUsageSnapshotSchema,
  type LocalUsageRequest,
  type LocalUsageSnapshot,
} from "./contract.js";

export async function exampleUsageStatsLocalProtocol(
  call: (request: LocalUsageRequest) => Promise<unknown>,
): Promise<LocalUsageSnapshot> {
  const request = localUsageRequestSchema.parse({ source: "all", range: "7d", timeZone: "UTC" });
  return localUsageSnapshotSchema.parse(await call(request));
}
