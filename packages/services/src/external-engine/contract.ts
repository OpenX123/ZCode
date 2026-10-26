import type { Event } from "@zcode/rpc";
import type { ExternalEngineStatus, ExternalSessionEngine } from "@zcode/shared/external-engine";
import { createServiceDescriptor } from "../descriptors.js";

// 外部 Agent 引擎（Claude Code / Codex）的安装与就绪检测服务，运行在执行 Host 上。
// 规则见 docs/desktop/external-agent-engines-spec.md：只读检测官方 CLI 与登录状态，
// 不读写凭据文件；adapter 只在用户显式调用 installAdapter 时安装。
export interface IExternalEngineService {
  /** 读取单个引擎的就绪状态；只读，不联网、不安装。 */
  getStatus(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 读取所有外部引擎的就绪状态。 */
  listStatuses(): Promise<ExternalEngineStatus[]>;
  /** 用户显式触发：从 npm 官方 registry 安装锁定版本的 adapter 到 YCode 管理目录。 */
  installAdapter(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 安装完成或检测结果变化时推送。 */
  onStatusChanged: Event<ExternalEngineStatus>;
}
export const IExternalEngineService =
  createServiceDescriptor<IExternalEngineService>("external-engine");
