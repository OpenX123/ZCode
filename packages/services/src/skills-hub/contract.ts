/**
 * Skills Hub 服务契约：外部技能同步的唯一写入者（Host 进程）。
 * 规则来源：docs/skills-hub-spec.md。
 */
import type { Event } from "@zcode/rpc";
import type { SkillsHubState } from "@zcode/shared/skills-hub";

/** 冲突选择持久化端口：nameKey → 用户选择的真实目录。生产实现写 AppSettings。 */
export interface SkillsHubChoiceStore {
  read(): Promise<Record<string, string>>;
  write(next: Record<string, string>): Promise<void>;
}

export interface SkillsHubOptions {
  /** 用户主目录；测试注入临时目录，生产与 skillsService 一致读取 HOME/USERPROFILE。 */
  homeDir: () => string;
  choices: SkillsHubChoiceStore;
  /** 仅桌面用户范围可用（对齐 skillsService capability.userScopeAvailable）。 */
  isAvailable: () => boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface ISkillsHub {
  /** 最近一次同步结果；尚未同步时执行一次同步。 */
  getState(): Promise<SkillsHubState>;
  /** 扫描来源、对账受管链接并写清单；进程内串行、幂等。 */
  sync(): Promise<SkillsHubState>;
  /** 只删除“确认列表 ∩ 最新清理候选”中的链接条目，然后再同步一次。 */
  prune(entryNames: readonly string[]): Promise<SkillsHubState>;
  /** realDir 为 null 时恢复默认优先级。 */
  setConflictChoice(nameKey: string, realDir: string | null): Promise<SkillsHubState>;
  /** 清空“新发现”待显示列表。 */
  dismissDiscoveries(): Promise<SkillsHubState>;
  readonly onDidChange: Event<SkillsHubState>;
}
