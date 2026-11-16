import type { SourceServerOperationLogsContract } from "./contract.js";

/** 装配方传入 manager 既有实例；任务与 context 沿同一 run 执行，事件后按原 Profile 查询。 */
export async function exampleSourceServerOperationLogs(
  owner: SourceServerOperationLogsContract,
  ...args: Parameters<SourceServerOperationLogsContract["run"]>
) {
  await owner.run(...args);
  return owner.read(args[1]);
}
