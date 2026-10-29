# 外部引擎 Runtime

在普通 turn 的持久化与事件生命周期内执行 ACP 端口，不创建 ZCode Model。文本、思考、工具与 diff 使用既有 SessionEvent 和 transcript part。权限复用 broker，allow_once/allow_always/reject_once 根据原 options 映射；不存在对应选项即取消。外部会话 id 在 prompt 前落库，失败恢复不可创建新上下文。配置事件由 runtime 单一 owner 发出。排队、TurnStarted/Complete/Error 与 usage 由上层普通 turn 生命周期收口。

草稿 createSession ACK 前通过 prepareSession 初始化同一个 ACP 连接并投影模型/模式/命令，不提交 prompt、不创建 turn。externalSessionId 先保存在 runtime，首发提升时随会话写入；只有已持久化会话才更新 store。

正文与思考使用成对 start/delta/end 事件；切换类型、开始工具以及 turn 退出前关闭当前 part，确保实时投影与持久化分段一致。运行中配置仍由同一 runtime 经 ACP 确认后发布，不改变已发送请求。

工具参数、输出和活动通过 ToolCallProgress 更新同一调用；parentToolUseId 映射为 parentToolCallId，并保存在 ToolPart.metadata。子 Agent 文字仅更新父工具活动，不进入主回答。终态后的迟到更新不得重开工具。原始输出与 terminal 元数据优先于包装后的 content，空 content 不丢 rawOutput。

历史冷恢复读取 external_engine_config session entry，然后 prepare 原 externalSessionId 并投影 connecting/ready/error。只有原生确认值才持久化；首发提升补写草稿配置。失败保留历史和保存值，显式重试复用同一 prepare 入口。

runTurn 抛错意味着 adapter 已清理连接，Runtime 在 turn 收尾前发布配置 error，保留原生会话 ID 与已确认值。正常 cancelled 返回保留 ready；配置业务拒绝不改变连接状态，配置中的连接故障进入同一错误投影和既有显式重试入口。
