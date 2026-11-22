/**
 * usage-stats-local-ui 标准用法：设置页直接渲染面板，数据由面板内部 hook 经 useServices 获取。
 */
import { createElement } from "react";
import { LocalUsagePanel } from "./index.js";

export function exampleUsageStatsLocalUi() {
  return createElement(LocalUsagePanel);
}
