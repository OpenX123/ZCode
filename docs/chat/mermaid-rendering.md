# Mermaid 渲染

## 范围

- 聊天消息、Markdown 预览、工具输出里标记为 `mermaid` / `mmd` 的 fenced code block 会渲染为 Mermaid 图表；未标语言但首行明显是 Mermaid 图表语法的纯文本 code block 也会自动渲染。
- 右侧代码查看器识别 `.mmd` / `.mermaid` 文件时也会直接展示图表。

## 实现

- 语言识别统一走 `packages/ui/src/lib/mermaidLanguage.ts`，避免不同入口手写判断。
- 图表渲染组件为 `packages/ui/src/components/ai-elements/mermaid-block.tsx`，使用 `@streamdown/mermaid` 的 Mermaid 实例，并读取当前主题 token 生成 Mermaid `themeVariables`。
- `mermaid-rendering` 模块拥有当前 renderer 进程内唯一的成功结果缓存、同键进行中请求和串行渲染队列，避免多个图表同时初始化 Mermaid 全局配置时互相覆盖主题。
- 缓存按完整源码及实际 Mermaid 配置（主题 token、字体、渲染版本）精确匹配；成功结果按条数和字节数限制 LRU，不写会话数据库。组件挂载同步读取成功缓存，避免切 Tab 时先出现 loading。缓存淘汰、源码或配置变化后允许重新渲染。
- SVG 缓存为模板，聊天和放大预览各自分配实例命名空间，同时替换 ID、样式选择器与 fragment 引用，避免双栏相互引用 marker 或样式。

## 放大预览

- Mermaid 图表渲染入口放在代码块 header 操作区，位于复制按钮左侧，桌面端和移动端都常驻显示；图表尚未渲染完成时按钮禁用。点击入口或双击图表区域打开预览弹窗。
- 预览弹窗由通用图表预览组件承载，桌面端使用接近全屏的 Dialog，移动端占满可用视口。弹窗只展示已渲染的 SVG，不重新解释 Markdown，也不改变流式消息边界。
- 预览打开后默认按弹窗可视区域和 SVG 可见图形边界执行 zoom-to-fit；小图也会在缩放上限内放大，Mermaid 外层背景画布不参与 fit。工具栏提供放大、缩小、缩放比例菜单（zoom to 50% / 100% / 200%、zoom to fit、reset zoom）和关闭；快捷键支持 `Esc` 关闭、`+` / `-` 缩放。
- 预览视口支持鼠标拖拽平移、滚轮平移、按指针位置缩放。macOS 触摸板捏合在浏览器里表现为 `ctrlKey` wheel 事件，弹窗内将其解释为以当前指针为中心的缩放；普通双指滚动保持为平移。
- 移动 Web 端通过 Pointer Events 支持单指拖拽平移和双指捏合缩放。所有手势只在弹窗内容区接管，避免影响聊天列表、远控 replayable 消息恢复和桌面 continuous 主链路。
- 图表主题继续复用当前 Mermaid themeVariables，预览容器使用 `--color-popover` / `--color-border` / `--color-foreground` 等设计 token，兼容亮色、暗色和 Zai 主题。

## 流式边界

- 首图前显示轻量生成状态；流式源码可解析后显示图表，后续候选失败时保留最近成功图。更新在完整行边界合并调度，单个图表最多一项执行中和一项最新待执行候选，不为每个 token 累积布局任务。
- 原始 Markdown 中图表围栏闭合即提交最终候选，不必等待整条消息结束；消息结束同样提交最后版本。异步结果只有仍匹配当前源码和配置才可提交，旧结果不能覆盖新图。
- 最终非法源码显示明确失败提示并可展开查看源码；已有成功图继续保留。失败结果不进入成功缓存。
- 页面隐藏时暂停新渲染，保留已显示图，恢复可见时处理最新候选。分栏缩放只改变 SVG 可用显示宽度，不触发 Mermaid 布局；主题 token 或字体变化会生成新配置版本，成功后原位替换。

```mermaid
flowchart TD
  A[源码或主题变化] --> B[读取成功缓存]
  B -->|命中| C[同步显示实例化 SVG]
  B -->|未命中| D{页面可见}
  D -->|否| E[保留旧图并等待可见]
  E --> D
  D -->|是| F[合并为当前块最新候选]
  F --> G[复用同键请求并进入串行队列]
  G --> H{渲染成功且仍为当前版本}
  H -->|是| I[缓存模板并原位更新]
  H -->|旧版本| J[忽略旧结果]
  H -->|失败| K[流式保留旧图 最终态可查看源码]
```
