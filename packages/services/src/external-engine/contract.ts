import type { Event } from "@zcode/rpc";
import type {
  ExternalEngineStatus,
  ExternalSessionEngine,
  ExternalEngineConnectionCommand,
  ExternalEngineConnectionTestInput,
  ExternalEngineConnectionTestResult,
  ExternalEngineConnectionUpdate,
  ExternalEngineConnectionsView,
} from "@zcode/shared/external-engine";
import { createServiceDescriptor } from "../descriptors.js";

// 外部 Agent 引擎（Claude Code / Codex）的安装、就绪检测与连接配置服务，运行在执行 Host 上。
// 状态检测只读；Host 是连接配置唯一写者，密钥复用凭据服务，登录写入对应身份目录。
// adapter 只在用户显式调用 installAdapter 时安装。
export interface IExternalEngineService {
  /** 读取单个引擎的就绪状态；只读，不联网、不安装。 */
  getStatus(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 发送门禁只检查安装和路径，不启动 CLI；健康续聊复用结果。 */
  isLaunchReady?(engine: ExternalSessionEngine): Promise<boolean>;
  /** 使缓存失效；可选 cancel 仅中止指定引擎的管理检查或安装，不影响会话。 */
  invalidateStatus?(engine: ExternalSessionEngine, cancel?: "check" | "install"): Promise<void>;
  /** 设置页显式刷新；发送路径继续复用缓存。 */
  refreshStatus?(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 两家引擎的配置视图（含内置配置与隐藏配置），不含凭据。 */
  getConnectionProfiles?(): Promise<ExternalEngineConnectionsView>;
  /** 唯一写入命令：新建 / 编辑（生成新 ID）/ 删除（隐藏）/ 选择上次使用。 */
  updateConnectionProfiles?(
    command: ExternalEngineConnectionCommand,
  ): Promise<ExternalEngineConnectionUpdate>;
  /** 官方登录方式的配置运行官方 CLI 登录命令；同一时间只有一个，可取消。 */
  login?(profileId: string): Promise<void>;
  cancelLogin?(): Promise<void>;
  /** 经正式 ACP 启动路径发起一次最小请求；同一时间只有一个，可取消。 */
  testConnection?(
    input: ExternalEngineConnectionTestInput,
  ): Promise<ExternalEngineConnectionTestResult>;
  cancelConnectionTest?(): Promise<void>;
  /** 读取所有外部引擎的就绪状态。 */
  listStatuses(): Promise<ExternalEngineStatus[]>;
  /** 用户显式触发：从 npm 官方 registry 安装锁定版本的 adapter 到 YCode 管理目录。 */
  installAdapter(engine: ExternalSessionEngine): Promise<ExternalEngineStatus>;
  /** 安装完成或检测结果变化时推送。 */
  onStatusChanged: Event<ExternalEngineStatus>;
  /** 本 Host 写入连接配置后推送最新视图。 */
  onConnectionProfilesChanged?: Event<ExternalEngineConnectionsView>;
}
export const IExternalEngineService =
  createServiceDescriptor<IExternalEngineService>("external-engine");
