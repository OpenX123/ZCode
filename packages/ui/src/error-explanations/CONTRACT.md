# error-explanations

常见失败的人话归类（规则见 [原生计划错误规范](../../../../docs/desktop/native-plan-errors-spec.md)「1.5.0 外观」）。

- 纯函数，无状态：只读已在 ACP adapter / V4 投影边界脱敏的 HTTP 状态、错误码、错误源与消息，不新增协议字段。
- `classifyErrorExplanation`：HTTP 状态优先，其次按文本模式匹配（上下文过长先于鉴权/网络等泛化词）；归类不到返回 `undefined`，由调用方显示原摘要。
- `errorExplanationTitleId` / `errorExplanationHintId`：返回 `chat.error.explain.<kind>.*` i18n key。
- 使用方：`TurnFailureRow`（error-diagnostics）与 `ChatErrorBanner`。
