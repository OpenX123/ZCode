/**
 * 根据 test-ids 常量值生成 CSS 属性选择器。
 * 用法: sel(TID_TASK_SETTINGS_BUTTON) => '[data-testid="task-settings-button"]'
 */
export function sel(tid: string): string {
  return `[data-testid="${tid}"]`;
}
