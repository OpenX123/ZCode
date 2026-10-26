import { createContext, createElement, useContext, type ReactNode } from "react";
import type { ZCodeSlashCommand } from "@zcode/shared";
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "../store/zcodeSessionStore.js";

const SlashCommandsContext = createContext<readonly ZCodeSlashCommand[] | undefined>(undefined);

/** 会话引擎目录覆盖 workspace 目录；空数组明确表示引擎尚未提供命令。 */
export function SlashCommandsProvider({
  commands,
  children,
}: {
  commands?: readonly ZCodeSlashCommand[];
  children: ReactNode;
}) {
  return createElement(SlashCommandsContext.Provider, { value: commands }, children);
}

/**
 * ZCode Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  const commands = useContext(SlashCommandsContext);
  const workspaceCommands = useZCodeSessionStore(
    (state) => selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
  return commands ?? workspaceCommands;
}
