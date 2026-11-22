import type { Event } from "@zcode/rpc";
import type { ZCodeProvider, SkillsPromptContext, SkillsListResult } from "@zcode/shared";
import type { SkillsHubState } from "@zcode/shared/skills-hub";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** 将指定 skill 复制到通用目录（.zcode/skills），成功后返回新 skill 的路径。 */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** 从通用目录中移除指定 skill（仅当 skill 位于 .zcode/skills 时有效）。 */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * 删除本地技能（仅 workspace/user 作用域；plugin 作用域拒绝）。
   * 删除技能所在目录，仅允许命中 .zcode/skills 或 .agents/skills 根，越界则拒绝。
   */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /** Skills Hub：最近一次外部技能同步结果；尚未同步时执行一次（docs/skills-hub-spec.md）。 */
  getHubState(): Promise<SkillsHubState>;
  /** 立即同步外部技能（Claude / Codex / Claude 插件）到 YCode 技能根。 */
  syncHub(): Promise<SkillsHubState>;
  /** 删除用户确认且仍为清理候选的链接条目（只删链接）。 */
  pruneHubLinks(params: { entryNames: string[] }): Promise<SkillsHubState>;
  /** 冲突选择：realDir 为 null 时恢复默认优先级。 */
  setHubConflictChoice(params: {
    nameKey: string;
    realDir: string | null;
  }): Promise<SkillsHubState>;
  /** 清空“新发现”提示。 */
  dismissHubDiscoveries(): Promise<SkillsHubState>;
  /** 每次同步、清理或改选后广播最新 Hub 状态。 */
  readonly onDidChangeHub: Event<SkillsHubState>;
}

export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills);
