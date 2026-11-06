import type {
  GitSessionWorktreeRequest,
  GitSessionWorktreeResult,
  GitSessionWorktreeRollbackResult,
} from "@zcode/shared";

export interface GitSessionWorktreeManager {
  getPreparation(request: GitSessionWorktreeRequest): Promise<GitSessionWorktreeResult | undefined>;
  prepare(request: GitSessionWorktreeRequest): Promise<GitSessionWorktreeResult>;
  rollback(request: GitSessionWorktreeRequest): Promise<GitSessionWorktreeRollbackResult>;
}
