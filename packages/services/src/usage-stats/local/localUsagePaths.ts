import { homedir } from "node:os";
import { resolveYCodeDataRoot } from "@zcode/shared/ycode-data-root";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** 与 settingService 一致：独立桌面 Dev 实例的显式 home 优先，避免污染/读取真实用户目录。 */
export function resolveLocalHomeDir(env: Env = process.env): string {
  return (
    env.ZCODE_DESKTOP_HOME_DIR?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  );
}

/** Claude Code 日志根：CLAUDE_CONFIG_DIR（可逗号分隔）/projects；未设置时 ~/.claude 与 ~/.config/claude。 */
export function resolveClaudeProjectDirs(env: Env = process.env): string[] {
  const configured = env.CLAUDE_CONFIG_DIR?.split(",")
    .map((dir) => dir.trim())
    .filter(Boolean);
  const roots =
    configured && configured.length > 0
      ? configured
      : [
          join(resolveLocalHomeDir(env), ".claude"),
          join(resolveLocalHomeDir(env), ".config", "claude"),
        ];
  return [...new Set(roots.map((root) => join(root, "projects")))];
}

/** Codex 日志根：CODEX_HOME 或 ~/.codex。 */
export function resolveCodexHome(env: Env = process.env): string {
  return env.CODEX_HOME?.trim() || join(resolveLocalHomeDir(env), ".codex");
}

/** 本机用量缓存与价格文件位于应用数据目录 ~/.ycode/v2/usage-stats（未迁移时为 ~/.zcode）。 */
export function resolveUsageStatsDataDir(env: Env = process.env): string {
  return join(resolveYCodeDataRoot(resolveLocalHomeDir(env)), "v2", "usage-stats");
}
