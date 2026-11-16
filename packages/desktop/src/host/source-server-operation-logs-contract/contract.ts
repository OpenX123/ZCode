import type { SourceServerOperationLogs } from "../sourceServerOperationLogs.js";

/**
 * 既有 Host 日志实例的结构合同；方法、泛型与事件均来自同一实现，不另起状态。
 * run 的任务结果决定成功后的 Source/Profile 关联，read 只返回派生克隆。
 * 删除/释放前由 manager 先撤销在途任务；日志代次仅使旧 onLog 回调失效。
 */
export type SourceServerOperationLogsContract = Pick<
  SourceServerOperationLogs,
  "run" | "read" | "removeProfile" | "onDidAppend" | "dispose"
>;
