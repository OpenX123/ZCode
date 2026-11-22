# 任务标题引用显示（1.5.2）

## 背景

侧边栏任务标题来自 CLI `titleFromInput`（首条输入压缩空白后截断到 60 字符，超出用 `57 字符 + "..."`，只把技能链接 `[$name](…/SKILL.md)` 清理为 `$name`）或 LLM 生成标题（短输入或失败时跳过）。当首条输入以文件路径、网址、会话深链、图片占位或斜杠技能开头时，侧边栏会直接显示原始路径或链接，例如 `zcode://session/open?taskId=…&path=C:\Users\…`，可读性差且泄露过长路径。

## 产品规则

- **只改显示层**：存储的 `task.title`、重命名输入框、拖拽 `text/plain`、模型轨迹标题等仍使用原始标题；CLI `titleFromInput`、LLM 标题、`resolveZCodeVisibleSessionTitle` 不改。
- 标题解析为一组片段 `{ kind, label }`，`kind ∈ text | skill | session | file | url | image`。特殊片段显示为「图标 + 简短名称」，图标与名称间距 4px；普通片段原样显示。
- 标题仍为单行，沿用 `TaskTitleOverflowText` 现有的右侧渐隐与悬停走马灯溢出语义（侧边栏已统一不用省略号，见该组件注释）。
- 可读文本（片段 label 依次拼接）用于 `title`/无障碍名称，不暴露原始路径。
- 图标：16×16 viewBox、1.5 线宽、圆端点圆角、无填充、`currentColor`；侧边栏 14px、次要前景色（`text-foreground-subtle`），对话与输入框 chip 16px 并继承 chip 颜色。

### 解析规则

先把所有空白折叠为单个空格并去掉首尾空白，再从左到右识别：

| 原始形式                                                                                            | 片段                                                 | label                                                        |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `[$Label](…)`（任意位置）                                                                           | skill                                                | `Label`                                                      |
| 标题开头 `$slug`                                                                                    | skill                                                | `slug`                                                       |
| 标题开头 `/name`（单段，后面是空格或结尾）                                                          | skill                                                | `name`                                                       |
| `[#Title](#sess_id)`                                                                                | session                                              | `Title`                                                      |
| `#sess_xxx`                                                                                         | session                                              | 解析器按 taskId 查当前列表标题，查不到用「引用的会话」       |
| `zcode://` / `ycode://session/open?…`（含被 60 字符截断的前缀，如 `zcode://session/open?tas`）      | session                                              | 同上（taskId 取自 `parseSessionDeepLink` 或 `taskId=`）      |
| `[@Label](plugin://id)`                                                                             | text                                                 | `Label`（不显示链接，不配图标）                              |
| 其他 Markdown 链接 `[label](dest)`                                                                  | dest 为 http(s) → url；图片扩展名 → image；否则 file | url 用 label（label 本身是网址时取域名）；file 取 label 末段 |
| `http(s)://…`                                                                                       | url                                                  | 域名（host）                                                 |
| `file://…`                                                                                          | file / image                                         | 文件名                                                       |
| 绝对或显式相对路径：`C:\…`、`C:/…`、UNC `\\host\…`、POSIX `/a/b…`（至少两段）、`~/…`、`./…`、`../…` | file / image                                         | 文件名（末段）                                               |
| `[image]`、`[Image #n]`                                                                             | image                                                | 「图片」                                                     |

- 路径或文件名的扩展名为 `png/jpg/jpeg/gif/webp/bmp/svg/ico/heic/heif/avif/tif/tiff` 时为 image，label 为文件名。
- 网址、深链与路径的结尾标点（`.,;:!?)]}'"` 及中文全角标点）和截断产生的 `...`/`…` 不并入片段，作为普通文本保留在其后。
- 路径的文件名带扩展名且后面紧跟中文时，从扩展名之后切开（`C:\a\b.html打不开` → 文件 `b.html` + 文本 `打不开`）。路径本身含空格时只能识别到第一个空格前（已知限制）。
- 路径、`#sess_` 前面必须是开头、空白或左括号/引号，避免 `and/or/x` 这类正文被误判；网址与深链前面可以是任意字符（例如紧贴中文）。
- `@name`、非开头的 `$x`、`/x` 等保持原文。
- 解析结果全部为空时回退为原标题文本。

### 示例

| 原始标题                                                  | 显示                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `/fwq 连接一下我的相关云服务器为什么不行了`               | [技能]fwq 连接一下我的相关云服务器为什么不行了 |
| `zcode://session/open?taskId=sess_8f2c&path=C:\Users\me`  | [会话]Duobao Agent Server V3（查到时）         |
| `zcode://session/open?tas...`                             | [会话]引用的会话...                            |
| `C:\Users\me\docs\reports\sub2api-2026-11-19.html 打不开` | [文件]sub2api-2026-11-19.html 打不开           |
| `https://sub.artai.top/admin/groups 报 502`               | [网址]sub.artai.top 报 502                     |
| `[image] 这个报错什么意思`                                | [图片]图片 这个报错什么意思                    |
| `看下 ~/Desktop/shot.png`                                 | 看下 [图片]shot.png                            |

## 状态所有者与接口

- 唯一事实来源仍是 `task.title`（sessions-index 投影）。解析为纯函数 `parseTaskTitleDisplay(title, { resolveSessionTitle?, fallbackLabels? })`，无缓存、无副作用。
- 会话标题查找：任务列表（`TaskList` 的 `taskLookup`、`TaskGroupedView` 的 `tasks`）通过 `TaskTitleLookupProvider` 提供只读 `taskId → title` 查找；它是列表 props 的派生视图，不是第二份状态。被引用会话不在当前列表时显示「引用的会话」。
- 模块：`packages/ui/src/reference-icons`（managed，见 `CONTRACT.md`）提供五个图标数据、`ReferenceIcon` 组件、解析函数、`TaskTitleDisplay` 组件和查找 Provider。
- 使用方：`TaskListItem`（默认与 timeline 两种布局）、`project-sidebar/grouped/task-row`（分组视图）。
- 对话气泡 `ConversationUserInputContent` 与输入框 chip（`mentionIconDom` → `promptMentionDecoration`）的 skill、session 改用同一套图标；文件 chip 继续使用文件类型图标。

## 验收

1. 上表示例在单测中逐项断言（含 Windows 路径、UNC、截断深链、中文正文、图片占位）。
2. 侧边栏默认/timeline/分组三种行：含路径的标题显示图标 + 文件名，hover 走马灯与渐隐不变，重命名输入框仍为原始标题。
3. 引用的会话在列表中时显示其标题，不在时显示「引用的会话」/「Referenced session」。
4. 对话气泡与输入框中技能、会话 chip 显示新图标；文件 chip 不变。
5. 浅色/深色主题、390px 与 1200px 宽度下图标 14px、次要色、与文字基线对齐。
