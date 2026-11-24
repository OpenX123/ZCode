# Conversation Rendering Performance（当前事实）

V4 渲染边界是 `snapshot.rows.window`，不是 legacy `messages[]`。

```text
rows.window
  -> buildConversationTurnRenderUnits
  -> ConversationTurnGroup
  -> virtualizer visible range
  -> ConversationRowView
```

- `ConversationProjectionStore` 按 delta 更新 row/window；未变化 row 应保持稳定引用。
- `ConversationTimeline` 使用 `@tanstack/react-virtual`、动态测高和 overscan，只渲染可见 turn。
- 流式 row 高度变化由测量回流；follow-bottom 是 UI 状态，不写入 projection。
- 行高缓存（`timelineRowHeightCache.ts`）按会话坐标系（`scrollMemoryKey` + `sessionKey`）持有：切换会话才清空；workbench tab 隐藏后重新可见（`paused` 切换）必须保留，否则恢复滚动期间新挂载的行按 72px 估算绘制并互相覆盖。隐藏时 0 高度测量不写入缓存。
- 性能优化不能合并不同 seq、丢 row action、破坏 terminal snapshot 一致性或让 renderer 维护第二份消息数组。

主要入口：`packages/ui/src/v4/ConversationTimeline.tsx`、`ConversationRowView.tsx`、`ConversationProjectionStore.ts`。
