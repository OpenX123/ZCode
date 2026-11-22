import type { ReactNode, SVGProps } from "react";

/** 引用类图标的五种类别；侧边栏标题片段与对话/输入框 chip 共用。 */
export type ReferenceIconKind = "skill" | "session" | "file" | "url" | "image";

/**
 * 与 lucide IconNode 相同的数据形状（标签 + 属性），供 React 组件和
 * Lexical 原生 DOM（`mentionIconDom`）共用同一份图标数据。
 */
export type ReferenceIconNode = ReadonlyArray<
  readonly ["path" | "circle" | "rect", Readonly<Record<string, string>>]
>;

export interface ReferenceIconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "ref"> {
  kind: ReferenceIconKind;
  /** 像素尺寸；侧边栏 14，chip 16。 */
  size?: number;
}

export type TaskTitleSegmentKind = "text" | ReferenceIconKind;

/** 显示层片段；label 已是可读文本，不含原始路径或链接。 */
export interface TaskTitleSegment {
  kind: TaskTitleSegmentKind;
  label: string;
}

export interface TaskTitleFallbackLabels {
  /** 引用会话查不到标题时的显示名（i18n「引用的会话」）。 */
  session: string;
  /** 图片占位没有文件名时的显示名（i18n「图片」）。 */
  image: string;
}

export interface ParseTaskTitleDisplayOptions {
  /** 按 taskId 查当前任务列表中的标题；查不到返回 undefined。 */
  resolveSessionTitle?: (taskId: string) => string | undefined;
  fallbackLabels?: TaskTitleFallbackLabels;
}

/** 只读 taskId → 标题查找；由任务列表从自身 props 派生提供，不是第二份状态。 */
export type TaskTitleLookup = (taskId: string) => string | undefined;

export interface TaskTitleLookupProviderProps {
  tasks: ReadonlyArray<{ taskId: string; title?: string | null }>;
  children?: ReactNode;
}

export interface TaskTitleDisplayProps {
  /** 原始（存储的）任务标题；为空时调用方先换成「新任务」等占位。 */
  title: string;
  fallbackLabels: TaskTitleFallbackLabels;
  /** 图标额外 class；默认 14px 次要前景色。 */
  iconClassName?: string;
}
