# large-text-preview

Preview Pane 的大文件文本预览（规则见 [Preview Pane「大文件预览」](../../../../docs/ui/preview-pane.md)）。

- 档位：`classifyTextFilePreview` 依据首块（1MB）`truncated` / `totalBytes` 判定 `full`（≤1MB 或二进制）、`large`（1MB–50MB）、`tooLarge`（>50MB）。
- 读取：调用方注入 `TextChunkReader`（绑定 path 与 workspace-scoped `fileService.readTextFile`），本模块不直接访问服务；每块以 `offset + bytesRead` 推进，service 保证块边界在 UTF-8 字符边界。
- 状态：`LargeTextFileViewer` 自持分块行缓冲（`ChunkedTextLines`），以 path 为 key 挂载，卸载后迟到结果丢弃；不写 store、不缓存跨 source 内容。
- “仍然渲染”：`readFullTextFile` 从首块之后顺序读到 EOF（≤50MB），返回单个完整 `FileTextSlice`，支持取消回调。
