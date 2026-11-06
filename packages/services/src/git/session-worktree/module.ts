export const gitSessionWorktreeModule = {
  id: "git-session-worktree",
  requires: ["services", "shared"],
  provides: ["git-session-worktree"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
