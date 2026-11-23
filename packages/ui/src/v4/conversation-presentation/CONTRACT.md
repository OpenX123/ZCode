# conversation-presentation

Renderer 展示派生的唯一边界；输入是已经收到的 V4 行，输出是带来源区间的纯投影。

- UX05 纯 helper 按已收到的 MIME 或识别扩展名分类 image/audio/video，并从正文提取闭合 Markdown 链接/图片与以换行确认完整的独立 URL，供既有 MessageResponse 内嵌媒体；未知 MIME/无扩展名 URL 保持普通链接，不发起探测。资源读取、重试、blob URL 生命周期由既有 renderer 消费方负责，公开入口不引入组件或服务。
- 1.6.1 已移除“成果摘录”投影（UX04）与 text fence 打开动作：本模块不再生成折叠外摘录行、上下文区间、挂载身份或 typedMedia 引用；flow 只按原行序渲染。
- 代码块、行内代码、缩进代码与命令中的 URL 不会成为引用；`text` fence 同样只作为代码展示。
- 不写回行、协议、业务状态或媒体事实，不做网络、文件 IO，不持有服务。
- 五件套与公开 index 只依赖 shared 类型与纯媒体格式注册表；本模块属于共享只读时间线的安全依赖闭包。

- UX06 `buildConversationMcpGroups` 是只读连续投影：保留非成员行及原生父子身份，专用 Node REPL/CUA/插件交互不接管。同服务组只能跨相邻同 turn、同 parent 的 MCP 行。
- 服务比较使用完整身份而非展示短名：discovery 的完整配置 serverName 与 legacy 未缩短 encoded server 段分别处于独立身份域。旧 envelope 无法无损映射 discovery 键，跨来源保守断组，允许混合格式的真实同服务多一组；不猜标签、不新增映射缓存，既有机械短名显示不变。
- UX06 `resolveConversationDisclosureKeys` 纯身份构造隔离 workspace/remote/session/epoch/turn/类型/调用；`disclosure.tsx` 为独立 UI 公开入口，存且仅存手动 override，暴露订阅供内层折叠与外层历史提升共用。纯 index 不导出 React 或可写状态。
- 连续组成员作为 override 别名，按最后手动意图恢复前插/增量后的组；组与子项 namespace 独立。默认态由当前投影派生，手动 override 始终优先。外层提升相关手动打开/失败项，不扩大无关历史。

- MCP 历史只接受三个 `__` 分段的显式 envelope；renderer 与纯分组共用同一机械 legacy presentation reader，避免插件路由命名在新组摘要中重新外露。
- MCP 失败从 canonical `output.display.isError`（仅 true）、旧 `display.ui.isError`、明确 error 状态/标签派生，不猜正文。该标记沿原 MCP result/display/metadata/live/cold owner 传递，不改变 V4 执行 success。旧无字段普通 MCP 历史不追溯推断。
