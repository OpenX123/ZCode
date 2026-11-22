# Preview Pane

## 目标

右侧 Preview Pane 用于在 side pane tab 中预览工具调用、文件链接和工作区文件。它只负责展示，不直接解析业务语义；预览数据由 `packages/ui/src/lib/codeViewer.ts` 和调用方构造成 `CodeViewerSource` 后传入。

## 支持的预览类型

- `file`：按路径读取真实文件内容；文本文件按大小分三档（见“大文件预览”）：`≤1MB` 完整读取并正常渲染，`1MB–50MB` 进入大文件简化模式，`>50MB` 显示本地化提示并引导使用外部编辑器；二进制文件按文件类型分派专门的预览适配（当前为图片、媒体、PDF、PPTX），未适配的类型仍显示不可预览提示
- `text`：直接渲染内存中的文本内容，按 `language` 使用代码高亮
- `patch`：渲染 unified diff / patch，保留增删行语义
- `image`：读取媒体预览并显示图片；当前识别 `apng`、`avif`、`bmp`、`gif`、`ico`、`jpeg`、`jpg`、`png`、`svg`、`webp`
- `media`：使用原生 `video` / `audio` 控件预览 MP4、MOV、WebM、M4V、MP3、WAV、M4A、OGG、Opus、FLAC 和 WEBA；Desktop 本地文件通过授权 `zcode-media://` URL，Desktop SSH/WSL/Docker 文件通过 Host loopback HTTP Range Proxy，手机 `/remote` 仅使用 workspace-scoped 小文件 inline 读取
- `pdf`：渲染 PDF 只读预览；当前识别 `pdf`，只提供预览能力，不提供编辑能力。所有入口统一创建 `file` source，由 PreviewPane 的 `resolvePreviewPanePdfSource` 惰性升级为 `pdf`（与 image 的升级模式一致），保证 tab key 全部走 `file:{path}` 去重。数据加载走 `fileService` 的分段读取（`stat` 拿 size；小于 `2MB` 循环 `readFileRange` 拉全量，超过则交给 pdf.js range 按需分段加载），无整档大小上限；旧远端（`stat` 不返回 `size`）回退整档 base64 的 `readMediaPreview` 旧通道，保留其 8MB 上限
- `office`：以只读模式预览 `.xlsx`、`.xlsm`、`.xls`、`.docx` 和 `.doc`；Excel 以 `.xlsx` 为完整支持路径，`.xlsm` / `.xls` 仅展示渲染库能够解析的数据，`.docx` / `.doc` 统一交给 Word 渲染器
- `pptx`：渲染 PPTX 只读预览；当前识别 `.pptx`，以左侧垂直缩略图列表和右侧单页预览展示，底部工具栏提供翻页、页码跳转和缩放。所有入口仍创建 `file` source，由 PreviewPane 惰性升级为 `pptx`，保证 tab key 继续走 `file:{path}` 去重。第一期只实现 `PresentationPreviewEngine`，编辑、导出、写回仅保留分层接口。新 Host 使用 `64MB` 上限；旧远端缺少 `stat.size/readFileRange` 时保留 `8MB` base64 兼容上限，并显示独立的本地化提示而不是误报 `64MB` 或透出远端路径。详见 `docs/ui/pptx-preview.md`

## 文件与文本渲染规则

- `.md` / `.markdown` 文件和 markdown 文本 source 默认进入预览模式，可在更多菜单切换到源码
- `.svg` 文件和带 `.svg` path 的文本 source 默认进入 SVG 预览，可切换到代码；切到代码模式后可继续使用自动换行开关
- 图片预览使用 4px 马赛克背景，内容区保留 `p-10`；位图默认按自然尺寸显示，文件名带 `@2x`、`@3x`、`@1.5x` 等倍率时，会按倍率折算为对应 CSS 展示尺寸，并继续受容器最大宽高约束；SVG 作为矢量图按容器 `contain` 适配，不参与位图倍率折算
- Office 文件通过 workspace-scoped `fileService` 读取完整二进制内容，跨 RPC 传输上限为 25 MB；渲染器和 WASM 资产按文件类型懒加载，避免增加普通文本、图片预览的首屏负担
- Excel 预览使用当前 Zai Light / Dark 主题；DOCX 页面保持白纸语义，桌面端与手机 Web 均可在预览容器内滚动访问完整内容
- 普通代码文件使用基于 Shiki tokens 的语法高亮，更多菜单提供自动换行开关
- 代码源码渲染为逐行结构：每行包含不可选中的 `line` 行号区和可选中的 `code` 内容区
- 横向滚动时 `line` 行号区保持 sticky 固定；开启自动换行后，仅 `code` 内容区参与换行
- 普通文本/代码文件的大小分档、分块读取和简化渲染规则见下文“大文件预览”；这些上限只约束普通文本/代码预览，PDF、PPTX 和 Office 文件继续使用各自的二进制读取、大小限制和渲染链路
- `.pdf` 文件进入 PDF 只读预览，按页渲染并支持滚动浏览；不提供源码视图切换，当前版本不提供编辑、批注能力
- Word、Excel、PPTX 与 PDF 文档预览的通用顶部标题栏下方必须展示 `border-border` 横向分隔线；普通代码、图片、Markdown 等预览保持原有无分隔线标题栏。
- `.pptx` 文件进入 PPTX 只读预览，主区域只挂载选中页；不提供源码视图、内置编辑、导出或保存能力，
  但顶栏保留与 XLSX、DOCX 相同的通用“在外部编辑器打开”按钮，该操作不属于 Preview Pane 内部编辑或写回

## 大文件预览（1.5.0）

文本文件按 `readTextFile` 返回的 `totalBytes` 分三档。本地与远程（SSH / WSL / Docker 工作区，经同一 workspace-scoped `fileService` RPC）使用同一组上限：

| 档位   | 大小         | 行为                                                                                                                                           |
| ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常   | `≤ 1MB`      | 一次读取完整文档，Shiki 高亮，Markdown / SVG / HTML 照常预览                                                                                   |
| 大文件 | `1MB – 50MB` | 简化显示：按 `1MB` 分块按需读取，虚拟滚动纯文本（保留行号，关闭高亮及 Markdown/SVG/HTML 预览），顶部提示条“大文件，已简化显示”和“仍然渲染”按钮 |
| 超限   | `> 50MB`     | 不读取正文，显示本地化提示，引导用户使用外部编辑器（保留顶栏“在外部编辑器打开”入口）                                                           |

- 状态所有者：`PreviewPane` 持有当前 source 的读取生命周期；大文件模式的分块读取由 `LargeTextFileViewer` 按滚动位置驱动，切换 source 或卸载后，迟到的分块结果一律丢弃。
- 单次 RPC 读取上限：service 层 `readTextFile` 单次 `length` 上限为 `1MB`（`MAX_TEXT_READ_BYTES`），客户端以 `offset` 连续推进，不存在 50MB 的单次读取。
- UTF-8 边界：service 在非 EOF 的分块末尾回退到最后一个完整 UTF-8 字符边界，`bytesRead` 只计入完整字符，调用方以 `offset + bytesRead` 作为下一块起点，因此多字节字符不会被拆开而产生乱码；若起点落在续字节上（仅当调用方传入任意 offset 时），service 跳过前导续字节，`offset` 返回实际起点。
- 行拼接：大文件模式把上一块末尾未结束的行与下一块开头合并，行号全局连续；滚动到距已加载内容底部不足一屏时读取下一块，读完后不再请求。
- 首块复用：预览首次读取 `1MB`。若 `truncated=false`，进入正常档；否则依据 `totalBytes` 判定为大文件档或超限档，首块直接作为大文件模式的第一块，不重复读取。
- 二进制探测仍以首块判断；首块为二进制时沿用“不可预览”提示。
- “仍然渲染”：用户显式确认后，按 `1MB` 分块顺序读取完整文件（≤50MB），拼接为单个文档后进入正常渲染管线（高亮 / Markdown / HTML 预览）；读取期间显示加载态，失败时回到大文件模式并显示错误。该选择只对当前 tab 的当前 source 生效，切换 source 后复位。
- i18n 命名空间：`preview.largeFile.*`（zh-CN / en-US 同步）。

### HTML 默认源码

`.html` / `.htm` 文件和带 HTML path 的文本 source 默认显示源码（Shiki 高亮），更多菜单的“HTML”分组提供“预览 / 源码”切换；切换到预览后沿用下文的 sandbox iframe 静态预览规则。切换 source 后复位为源码。

### 验收

- 0.5MB 文本：正常高亮。
- 5MB 日志：显示提示条；滚动到底部时持续按块加载，行号连续，中文跨块边界无乱码。
- 5MB 文件点击“仍然渲染”：完整文档进入高亮渲染。
- 60MB 文件：显示超限提示，不发起正文分块读取。
- 远程工作区行为同上；HTML 文件打开时默认显示源码，可切换为预览。

## 路径处理

- Preview Pane 在入口处会规范化 `CodeViewerSource`，将本地路径中的 URI 转义还原，例如 `Auto%20Snake` 会显示并读取为 `Auto Snake`
- side pane 生成 tab key 前也会执行同样的规范化，避免同一个文件因为 `%20` 和空格两种写法被打开成两个 tab
- 路径只在文件读写、打开编辑器等路径语义中使用；workspace 隔离仍遵守 `workspaceIdentity?.trim() || workspacePath`

## 面包屑行为

- 顶部面包屑优先按当前 workspace 展示为 `workspace -> 目录 -> 文件`
- 长路径使用横向滚动，不压缩文件名区域
- 初次打开或切换 source 后，面包屑默认滚到最右侧，优先展示末尾目录和文件名
- 只有存在可滚动内容时才显示边缘 mask；位于左侧、中间、右侧时分别显示右侧、双侧、左侧渐隐

## 相关文件

- `packages/ui/src/PreviewPane.tsx`：pane 壳、面包屑、视图切换和文件读取生命周期
- `packages/ui/src/components/ui/code-viewer.tsx`：通用 `CodeViewer` Shiki 代码查看组件，负责逐行渲染、sticky 行号和换行策略；side pane 和后续 markdown 代码块复用同一入口
- `packages/ui/src/components/ui/pdf-viewer.tsx`：通用 `PdfViewer` PDF 只读预览组件，负责按页渲染与滚动浏览；由 preview pane 的 `pdf` source 分派使用，不承担编辑能力，详见 `docs/ui/pdf-viewer.md`
- `packages/ui/src/previewPanePdfContent.tsx`：pdf 正文薄包装，懒加载 `PdfViewer`（react-pdf 体积较大，只在首次打开 PDF 预览时进入 bundle）
- `packages/ui/src/previewPanePptxContent.tsx`：pptx 正文薄包装，懒加载 PPTX 预览组件和 `@aiden0z/pptx-renderer`
- `packages/ui/src/lib/shikiHighlighter.ts`：通用 Shiki 高亮缓存与异步 token 化入口，避免 `components/ui` 依赖 `ai-elements` 的实现细节
- `packages/ui/src/previewPaneContent.tsx`：按 `CodeViewerSource` 类型分派正文渲染
- `packages/ui/src/previewPaneOfficeContent.tsx`：Office 二进制解码、懒加载和统一错误边界
- `packages/ui/src/previewPaneOfficeXlsxContent.tsx`：Excel 只读渲染与主题适配
- `packages/ui/src/previewPaneOfficeDocxContent.tsx`：DOCX 解析、白纸主题和响应式容器
- `packages/ui/src/lib/officeFilePreview.ts`：Office 扩展名识别和 base64 解码
- `packages/ui/src/lib/codeViewer.ts`：预览 source 类型、工具调用预览提取、语言和图片类型识别
- `packages/ui/src/lib/codeViewerSource.ts`：Code Viewer source 路径规范化
- `packages/ui/src/lib/workspaceSidePane.ts`：Code Viewer tab key 生成与复用
- `docs/ui/office-file-preview.md`：Office 文件预览的边界、状态组合和验证契约

## HTML 文件预览（2026-10-30）

消息正文的 HTML/HTM 文件链接及文件卡片统一使用现有文件预览入口，由对应 workspace 的 file service 读取。1.5.0 起默认展示源码（见“HTML 默认源码”），切换到预览后展示 sandbox iframe 中的静态 HTML，禁用脚本、表单、弹窗及自动刷新，避免业务模板将预览跳转到 file:///login。支持预览/源码切换。HTML 中的内联样式与声明式资源按浏览器规则呈现；依赖脚本或后端的数据不伪造。桌面本地文件可从预览菜单显式“用内置浏览器运行”，走已有浏览器入口；远程与 Web 不把远端文件路径交给本机浏览器。

验收覆盖消息文件链接、HTML 文件卡片、源码切换，以及含登录重定向脚本和 meta refresh 的页面仍保留静态内容。HTTP 开发服务链接继续打开原 URL；现有文件树的显式浏览器动作保持运行语义。

相对资源以 HTML 文件目录（或显式 base）为基准。文件样式表、图片和 CSS 中的资源通过同一 workspace 的 file service 读取并内联，不能相对 Renderer 地址请求，也不能将 SSH 路径交给本机读取。保留脚本沙箱；资源读取失败不阻断已有正文。每次预览最多读取 64 个资源，每个沿用 8 MiB 预览上限；切换来源后丢弃迟到结果。验收包含相邻 CSS、CSS 相对图片及 Windows 路径。

相对资源回归：UI 定向 4 文件 95/95 通过；Electron 独立用例验证外置 CSS、相邻 SVG、CSS 背景图及预览/源码切换。资源准备完成后才挂载 iframe，避免空文档切换到正式 srcdoc 时 frame 上下文换代。报告位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20261030102501816-p15036-1c877319e2431533/summary.md`。

2026-10-30 验证：UI 定向 4 文件 93/93 通过。隔离 Electron 的 HTML 文件链接用例通过：真实 Host 读取文件，正文与样式可见，脚本未执行，meta refresh 未跳转，源码切回预览后内容仍可见，桌面本地运行入口存在。报告与截图位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20261030090832151-p99138-ea6a2a89a62358b6/`；候选保持 pending，未替换用户已安装应用。
