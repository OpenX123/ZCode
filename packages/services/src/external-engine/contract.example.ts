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
