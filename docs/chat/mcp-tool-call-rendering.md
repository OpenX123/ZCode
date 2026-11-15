# MCP tool call rendering

## Feature/change summary

Conversation MCP tool calls use MCP discovery metadata as their display source. The UI must not
infer business semantics from the synthetic model tool name (`mcp__<server>__<tool>`).

## Data flow

```text
MCP server tools/list
  name + description
          |
MCP adapter + configured server name
  serverName + toolName + description
          |
Core MCP registry metadata
          |
Scheduled / started / result display payload
          |
V4 ToolCallRow.display
          |
Conversation MCP renderer
```

`serverName` is the configured MCP server key. `toolName` and `description` come from the MCP
server's `tools/list` response. The synthetic model-visible name remains the stable execution
identifier and is only shown as a technical fallback.

## Summary

- Every MCP lifecycle row renders the stable kind label `MCP`, the server source as adjacent plain
  inline text, and the tool action after a quiet middle dot. The source is not a badge and must not add its own
  border, background, or rounded container. Plugin-scoped server keys such as
  `plugin:firebase:firebase` are display identifiers rather than user-facing copy: the source uses
  the final configured server segment (`Firebase`). When the tool identifier repeats that server
  prefix, the repeated prefix is removed mechanically (`firebase_get_environment` becomes
  `Get environment`).
- Trusted discovery metadata is attached when the call is scheduled, then preserved by started,
  result, error and turn-cancel projection updates. Pending, approval, running, failed and stopped
  rows must not regress to the synthetic tool name.
- Pending, running and completed are normal lifecycle phases and do not add status copy to the
  summary. Stopped and failed remain visible terminal exceptions; both are separated from the
  action with the same quiet middle dot used by the rest of the summary hierarchy. The resulting
  order is `MCP  Server · Action · Terminal status`.
- The UI only performs mechanical identifier formatting (separator-to-space and word
  capitalization). It must not translate verbs or invent domain meaning.
- Historical rows that predate presentation persistence are recognized only when their execution
  identifier has the protocol-owned `mcp__<server>__<tool>` envelope. Because that legacy envelope
  cannot losslessly recover discovery metadata, the compatibility summary shows `MCP` plus a
  mechanically formatted tool identifier and omits the server source and description. It must
  still use the MCP detail layout rather than exposing the generic debugger card.
- Missing or invalid presentation metadata on calls without that explicit MCP envelope falls back
  to the existing generic tool-call renderer.
- `description` is supporting information retained as the summary tooltip and shown only inside the
  secondary call-details disclosure; it is not a replacement title or part of the primary result.
- Discovery metadata is external input. Before it enters tool events or persistence, server/tool
  identifiers are trimmed and bounded to 256 characters, and descriptions are trimmed and bounded
  to 4 KiB. Empty bounded identifiers suppress the MCP presentation payload.
- Host Node REPL tools keep their existing dedicated renderer even when they carry MCP presentation
  metadata; the MCP label must not replace their code, error, artifact, or reset/configuration UX.

## Detail

- The default expanded detail shows the normalized tool result when one exists. Running rows may
  show their current lifecycle state as quiet supporting text until a result exists. It must not
  lead with description or parameters.
- Pending and stopped rows are summary-only lifecycle markers. They do not expose an expand affordance
  or render detail content because neither state has a user result to inspect.
- A secondary `View call details` disclosure follows the result and reuses the transparent BUA /
  Node REPL detail pattern. It contains the discovery description and normalized input when
  available; empty input is allowed here because this surface is explicitly diagnostic.
- The disclosure control and layout stay outside content cards. JSON or long technical data may use
  the existing bordered code surface inside the disclosure.
- Result presentation reuses the BUA / Node REPL visual primitives: a single-line result up to 160
  characters uses the compact bordered card, multiline or JSON output uses the bounded scrollable
  code surface with result actions, and failures use the compact destructive result surface. MCP
  must not fall back to the generic uppercase `RESULT` / `ERROR` debugger layout when trusted
  presentation metadata is available.
- The generic fallback's duplicate full `toolCall` JSON block is not rendered for MCP rows,
  including legacy rows recovered from the explicit MCP execution envelope.
- The synthetic tool name, IDs and raw projection fields remain available through diagnostics and
  snapshots; they are not repeated in the default reading path.
- Existing text, image and structured output rendering remains authoritative.

### Lifecycle matrix

| Row state                          | Summary                                    | Primary detail                     | Secondary call detail          |
| ---------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------------------ |
| input streaming / pending approval | MCP source + action; omit pending status   | not expandable                     | not expandable                 |
| running                            | MCP source + action; omit running status   | current status until output exists | description + normalized input |
| success                            | MCP source + action; omit completed status | result                             | description + normalized input |
| error                              | MCP source + action + failed status        | error/result                       | description + normalized input |
| cancelled / stopped                | MCP source + action + stopped status       | not expandable                     | not expandable                 |

## Compatibility and boundaries

- The display payload is optional and additive. Old persisted MCP sessions use the bounded legacy
  compatibility presentation above; other old providers continue to use the generic fallback.
- Presentation metadata does not participate in permission or security decisions. MCP identity for
  permission policy continues to come from the tool capability declaration.
- Desktop continuous and Web remote replayable paths consume the same persisted V4 row field; this
  change does not introduce a separate stream, queue, snapshot or recovery state.
- Pending and running tool-part persistence carries the bounded MCP display metadata. Cold
  hydration must reuse it when an unfinished call is closed as stopped, so `MCP server · tool ·
stopped` never regresses to the generic `Tool call · Stopped` summary.
- Streaming-early tool execution is a first durable writer rather than a later optimization: its
  pending and running part writes must carry the same bounded MCP display metadata before tool
  scheduling/execution. A turn Stop or process loss may happen before end-of-stream drain, so no
  later model-step write may be required to make cold/replayable recovery presentation-complete.
- Labels must use existing semantic color and `text-ui-*` tokens and remain usable on desktop and
  mobile Web, in both themes and locales.

## UX06 连续服务树与手动优先折叠

- `conversation-presentation/index.ts` 公开纯 `buildConversationMcpGroups`：仅按原行序把连续、同 turn、同原生 parentToolCallId 的同服务普通 MCP 行投影为组。正文（包括空 text + typed media）、其他工具、其他服务均截断；不重排、不写回 ID/parent/状态。缺 discovery 的历史只按显式 MCP envelope 回退。Node REPL、CUA 与插件交互保留专用 renderer。
- 服务身份与展示短名分离：discovery 行使用完整配置 `serverName`，legacy 行使用未缩短的 envelope encoded server 段，同短名的不同服务不得合组。旧 envelope 无法无损恢复 discovery 配置键，两种来源保持独立身份域，不猜测同一或缓存映射；混合格式中即使实际同服务也可能多一组。机械服务短名仅用于既有显示。
- 服务组摘要使用 SVG 插头图标、服务名称、调用数和真实子调用聚合状态；仍有活动调用时为运行中，否则按失败、停止、完成的优先级汇总，取消调用不能显示为全部完成。子卡沿用 MCP 结果优先与二级参数。组、子调用分别折叠，执行与权限身份仍为真实 toolCallId。
- 仅 MCP（以及后续明确接入的子任务）使用 `defaultOpen` 与用户 override：运行默认开、终态/冷历史默认关；手动开关优先于后续进度和终态。read/edit 规则不变。
- Renderer override 的唯一所有者是独立 `disclosure.tsx` 公开入口；只存手动布尔值与更新顺序，不存执行事实、不持久化。键包含 workspace identity/path fallback、remote session、session、epoch、turn、类型和真实调用 ID；组把一次手动意图关联到当前成员，增量和前插后按最新共同成员意图恢复，虚拟重挂复用。
- 错误以工具模型的 failed/output-error 语义判定。错误摘要在组/子卡折叠外常显；外层“已工作”收起时只提升失败组和正在手动查看的相关 MCP 项，其他历史照常折叠。手动关组可关闭正文，但不隐藏错误摘要。
- 普通 MCP 的 in-band 失败以原始 `output.isError === true` 生成受限 `display.isError?: true`，沿原 display/metadata/live/cold 链投影。Renderer 优先读取 canonical `output.display` 派生失败展示，原 V4 execution success 与 raw.v4Status 不变。旧无字段普通历史不解析文案追溯；已有 UI 资源 `ui.isError` 保持兼容。

```text
V4 rows（执行事实唯一来源）→ 纯连续组 → MCP renderer
                                      ↑ defaultOpen（由当前状态派生）
完整 scope + 调用身份 → renderer override owner → 组/子卡及外层已工作边界订阅
原 MCP result.isError → 既有 display/metadata → live/cold output.display → 失败展示（不改执行 success）
```

验收：A→A 合组、A→正文/媒体→A 拆组、A→B→A 三组；原生父子及专用 renderer 不变；运行开/成功关、手动优先、组子独立；混合失败摘要、父轮终态后手动查看、刷新冷历史、历史前插/虚拟重挂与跨 scope 隔离；主题/中英/窄屏/键盘。
