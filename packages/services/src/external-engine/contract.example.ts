import type { ExternalSessionEngine } from "@zcode/shared/external-engine";
import type { IExternalEngineService } from "./contract.js";

// 示例：设置页在用户点击安装后刷新状态；未就绪时保持只读展示，不隐式安装。
export async function installIfUserConfirmed(
  service: IExternalEngineService,
  engine: ExternalSessionEngine,
  userConfirmed: boolean,
) {
  const status = await service.getStatus(engine);
  if (status.adapter.installed || !userConfirmed) return status;
  return service.installAdapter(engine);
}

/** 管理页取消只作用于当前引擎；旧 Host 未提供取消时保持兼容。 */
export async function cancelEngineManagement(
  service: IExternalEngineService,
  engine: ExternalSessionEngine,
  operation: "check" | "install",
) {
  await service.invalidateStatus?.(engine, operation);
}
