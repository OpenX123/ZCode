# 默认主题

## 当前策略

- 应用首次启动且本地没有 `zcode-theme` 持久化值时，默认主题为 `dark`。
- 一旦用户主动切换主题，后续仍然优先读取本地保存值，不会被默认值覆盖。
- 侧栏太阳/月亮快捷按钮读取当前主题解析结果（包括 System 当前亮暗），只通过既有 store setter 写入明确的 `zai-light` 或 `zai-dark`。System 偏好变化仅刷新按钮展示，不另存主题偏好；设置页继续提供 System、浅色和深色选择。

## 实现位置

- Zustand store 默认值：`packages/ui/src/store/index.ts`
- 旧 `useTheme()` hook 兜底值：`packages/ui/src/useTheme.ts`
