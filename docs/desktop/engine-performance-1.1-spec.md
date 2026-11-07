# YCode 1.1 引擎性能 spec

决策来源：[YCode 1.1 更新方案](ycode-1.1-plan.md)「性能（问题 1）」。本文按工作流分节，各节自成一体；CLI 传输、MCP、插件摘要、Host/Renderer 发送路径等章节由对应工作流维护。

## 外部引擎进程

范围：外部引擎 `createSession` 的握手时机、预热备用进程、闲置 adapter 关闭以及相关性能事件。完整规则、状态所有者与时序图见 [外部 Agent 引擎](external-agent-engines-spec.md)「外部引擎进程与异步准备」，CLI 契约见 `apps/zcode-cli/docs/design/v2/external-agent-engines.md`。

- `createSession` 在记录建立、connecting 发布后即确认；握手在后台完成，进度沿用 `engineConfigState`（connecting → ready / error）。草稿就绪由预热会话 snapshot 派生，发送仍要等就绪。
- 每个（引擎，连接配置 ID）至多一个已完成 `initialize`（与 `providers/set`）的备用进程，只在桌面本地工作区、该对 `session/new` 成功后补位；`session/new` 时同步领用，10 分钟未领用关闭，失败只写日志并回落冷启动。
- 会话无在途操作、空闲 15 分钟、不在最近 3 个可恢复会话内时关闭 adapter（即使 Tab 打开），保留订阅、配置与 `externalSessionId`；下次发送或改配置经原会话恢复。常驻池对未订阅会话的回收由 10 分钟延长至 30 分钟。
- 性能事件：`external_engine.handshake.completed|failed`（各阶段耗时）、`external_engine.spare.claimed|miss|ready|expired|failed`、`external_engine.idle_close`、`external_engine.idle_resume.completed|failed`，均为 info（备用进程失败为 warn），不含正文。

| Case | 场景                       | 断言                                  | 验证层              |
| ---- | -------------------------- | ------------------------------------- | ------------------- |
| EP01 | 同配置连续新建两个外部草稿 | 第二个不再 spawn / initialize         | adapters 单测       |
| EP02 | 闲置 15 分钟后发送         | 恢复原会话，prompt 只发一次           | adapters 单测       |
| EP03 | 真实 Windows 连续使用一天  | 引擎子进程数与内存相对 1.0.5 显著下降 | 待真实 Windows 验证 |
