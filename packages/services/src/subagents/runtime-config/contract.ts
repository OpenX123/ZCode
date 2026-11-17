import type { SubagentRuntimeConfig, SubagentRuntimeState } from "@zcode/shared";

export interface Workspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ConfigReader {
  readUserRoot(): Promise<string>;
  readStatePath(): Promise<string>;
  readState(path: string): Promise<SubagentRuntimeState>;
}

/** Local Host service 持有实例；内部缓存与 scope 仍是原有状态的唯一 owner。 */
export interface SubagentRuntimeConfigCache {
  /** 首次准备或显式重载；可省略 workspace 以重载共享范围，不写入磁盘。 */
  prepare(workspace?: Workspace): Promise<void>;
  /** 仅已准备且未销毁时可读；返回完整 snapshot 的隔离副本，不写入磁盘。 */
  read(workspace: Workspace): Promise<SubagentRuntimeConfig>;
  /** 幂等关闭监听并取消加载；后续 prepare/read 拒绝，不发出公共事件。 */
  dispose(): void;
}
