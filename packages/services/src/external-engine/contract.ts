import type { Event } from "@zcode/rpc";
import type {
  ExternalEngineStatus,
  ExternalSessionEngine,
  ExternalEngineConnections,
  ExternalEngineConnectionProfile,
  SaveExternalEngineConnection,
} from "@zcode/shared/external-engine";
import { createServiceDescriptor } from "../descriptors.js";

// 外部 Agent 引擎（Claude Code / Codex）的安装与就绪检测服务，运行在执行 Host 上。
// 状态检测只读；用户显式保存的连接复用凭据服务，登录写入专用身份目录。
// adapter 只在用户显式调用 installAdapter 时安装。
export interface IExternalEngineService {
  /** 读取单个引擎的就绪状态；只读，不联网、不安装。 */
  getStatus(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 发送门禁只检查安装和路径，不启动 CLI；健康续聊复用结果。 */
  isLaunchReady?(engine: ExternalSessionEngine): Promise<boolean>;
  invalidateStatus?(engine: ExternalSessionEngine): Promise<void>;
  /** 设置页显式刷新；发送路径继续复用缓存。 */
  refreshStatus?(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  getConnectionProfiles?(): Promise<ExternalEngineConnections>;
  saveConnectionProfile?(
    input: SaveExternalEngineConnection,
  ): Promise<ExternalEngineConnectionProfile>;
  login?(profileId: string): Promise<void>;
  cancelLogin?(): Promise<void>;
  /** 读取所有外部引擎的就绪状态。 */
  listStatuses(): Promise<ExternalEngineStatus[]>;
  /** 用户显式触发：从 npm 官方 registry 安装锁定版本的 adapter 到 YCode 管理目录。 */
  installAdapter(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 安装完成或检测结果变化时推送。 */
  onStatusChanged: Event<ExternalEngineStatus>;
}
export const IExternalEngineService =
  createServiceDescriptor<IExternalEngineService>("external-engine");
