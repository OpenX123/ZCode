# 加粗包裹裸 URL（当前事实）

Assistant 正文中 `**http://127.0.0.1:21500/docs**。` 这类“加粗裸链接后紧跟中文标点”的写法，必须渲染为 `<strong>` 内的链接，链接地址不含 `**`。

## 规则

- GFM autolink literal 只剥离结尾的 `*`；`**` 后紧跟 `。`、`，`、`）` 等非空白字符时，`**` 会被吞进 URL。`@streamdown/cjk` 只在中文标点处截断链接，无法去掉 `**`。
- `autolinkStrongRemarkPlugin`（`packages/ui/src/components/ai-elements/message.tsx`）只处理裸链接字面量（唯一文本子节点即 URL，含 `www.` 形式）：在第一个 `**` 处截断链接文本与 URL，剩余部分作为后续文本；若链接前紧邻未配对的 `**`，把链接包成 `strong`。
- 插件挂在 `messageCjkPlugin.remarkPluginsAfter` 末尾。Streamdown 的 remark 顺序为 cjk before → 应用 `remarkPlugins` → cjk after → math，修复必须在 cjk 的链接拆分之后执行。
- 普通 `[text](url)` 链接、行内代码和代码块不受影响；流式中间态由 Streamdown 的未闭合 Markdown 补全后走同一插件。

## 验收

`packages/ui/test/messageMarkdownStrongAutolink.test.ts` 通过真实 `MessageResponse` 渲染覆盖：

| 输入                                     | 期望                                    |
| ---------------------------------------- | --------------------------------------- |
| `**http://127.0.0.1:21500/docs**。`      | strong 内链接 `…/docs`，后接 `。`       |
| `**http://x.test/a**，后文`              | strong 内链接 `http://x.test/a`         |
| `（**https://example.com/p**）`          | strong 内链接 `https://example.com/p`   |
| `**www.example.com**。`                  | strong 内链接 `http://www.example.com/` |
| `**http://a.test/x** 后文`               | 保持原有正确渲染                        |
| `这是**加粗：**文字`、`**“引用”**的说明` | CJK 加粗保持正确                        |
