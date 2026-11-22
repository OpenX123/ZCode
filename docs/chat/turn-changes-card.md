# 轮次更改卡片（1.5.0）

## 背景

对话右上角状态胶囊（`ConversationStatusPanel` 收起态）曾把工作区 git worktree 的全量 diff（`更改 +x −y`）作为主状态之一显示。该指标与当前对话无关：用户在别处的未提交改动也会出现在每个对话的胶囊里。与此同时，每轮助手回复末尾已有基于 runtime 文件编辑 checkpoint 的文件摘要（`ConversationFileSummaryPanel`），但文案和入口不够直接，无法一键审阅整轮 diff。

## 产品规则

1. 收起态胶囊不再显示 Git 变更指标。展开面板中的 Git Tools 区块（Changes / Branch / Commit）保持不变，Git 面板仍可查看工作区全部更改。
2. 每轮助手回复末尾显示 Codex 式卡片：`已更改 N 个文件  +x −y`（en-US：`Changed N files`，单数 `Changed 1 file`）。
   - 数据来自该轮 `TurnHeaderRow.fileChanges`（runtime 按该轮实际文件编辑工具的 checkpoint 统计，bash 产生的修改不计入）；该轮无改动（缺省或 `files <= 0`）时不显示。
   - 卡片右侧“审阅”按钮：读取该轮文件变更明细（既有 `fetchFileChanges`），把所有文件的 patch 合并为一个多文件 unified diff，在侧栏以 `patch` source 打开（标题“本轮更改”）；同一份 diff 重复点击复用已有 tab（tab key 含 patch 内容摘要）。
   - 展开箭头、逐文件“审查”、打开文件、撤销（rewind）等既有行为保持不变。
   - 已撤销（`state=reverted`）时保留“已撤销”徽标。
3. 明细读取失败或为空时，“审阅”按钮不打开空 tab，记录 warn 日志；卡片仍可展开重试。

## 所有者与接口

- 统计所有者：CLI runtime（`header.fileChanges` 与 `v4/conversation/fileChanges`），UI 不从工具调用重算。
- UI：`packages/ui/src/v4/ConversationFileSummaryPanel.tsx` 渲染卡片；多文件 patch 由纯函数 `buildTurnChangesPatch`（`packages/ui/src/v4/turnChangesPatch.ts`）生成，可单测。
- 胶囊：`StatusSummaryRow` 去掉 Git 分支；`conversationStatusPanelModel` 的 `git` 模型仍为展开区服务。
- i18n 命名空间：`chat.turnChanges.*`（zh-CN / en-US 同步）。

## 验收

- 有文件编辑的轮次显示“已更改 N 个文件 +x −y”，无编辑的轮次不显示。
- 点击“审阅”在侧栏打开包含该轮所有文件 diff 的 tab。
- 工作区有未提交改动但无 todo / goal 等主状态时，收起态胶囊不再显示 `更改 +x −y`；展开后 Git Tools 仍显示 Changes。
