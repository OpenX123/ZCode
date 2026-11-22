import { createContext, useContext, useMemo } from "react";
import type { TaskTitleLookup, TaskTitleLookupProviderProps } from "./contract.js";

const TaskTitleLookupContext = createContext<TaskTitleLookup | null>(null);

/**
 * 任务列表把自身已渲染的任务作为只读查找提供给标题解析（引用会话显示其标题）。
 * 这是列表 props 的派生视图，不另存状态；列表变化时随 props 重建。
 */
export function TaskTitleLookupProvider({ tasks, children }: TaskTitleLookupProviderProps) {
  const lookup = useMemo<TaskTitleLookup>(() => {
    const titles = new Map<string, string>();
    for (const task of tasks) {
      const title = task.title?.trim();
      if (title) titles.set(task.taskId, title);
    }
    return (taskId) => titles.get(taskId);
  }, [tasks]);
  return <TaskTitleLookupContext value={lookup}>{children}</TaskTitleLookupContext>;
}

export function useTaskTitleLookup(): TaskTitleLookup | null {
  return useContext(TaskTitleLookupContext);
}
