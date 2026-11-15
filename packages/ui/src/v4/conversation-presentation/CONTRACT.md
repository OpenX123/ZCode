# conversation-presentation

Renderer 展示派生的唯一边界；输入是已经收到的 V4 行，输出是带来源区间的纯投影。

- UX05 纯 helper 按已收到的 MIME 或识别扩展名分类 image/audio/video，提取闭合正文引用；未知 MIME/无扩展名 URL 保持网页，不发起探测。资源读取、重试、blob URL 生命周期由既有 renderer 消费方负责，公开入口不引入组件或服务。
- UX05 已类型化 `row.media` 同样投影为常显成果，空正文也有效。每个媒体保留独立 `typedMedia` 引用和源 row/id，不与文本区间合并；正文缓存不缓存媒体，媒体增量不得被相同正文吞掉。派生行只包含该单项 media，不复制整行媒体列表。
- 类型化媒体挂载身份包含类型、MIME 和完整目标，与普通链接区分，并继续隔离完整 scope；来源行/id仅用于溯源。最终或更早已展示的同类媒体才覆盖，最终普通网页卡不等于已内嵌媒体。一行多媒体逐项覆盖，部分覆盖保留其余媒体，原历史及最终正文不改写。
- 匿名分享仅呈现类型化媒体的 HTTP 来源按钮或本地附件名称/MIME，不自动请求 URL、不读取 artifact、不把本地 URI 放进可点击入口；认证正文沿既有 scoped reader 渲染。成果投影不新增 action 或自动打开。

- 不写回行、协议、业务状态或媒体事实，不做网络、文件 IO，不持有服务。
- 成果只接纳明确闭合引用，保留完整目标和说明段落；代码和命令不会变为成果。
- 完整原段只展示一次；最终正文覆盖该段全部目标时省略，部分覆盖时保留完整原句，不能为删重裁剪上下文。
- 来源 key/range 描述实际选中来源，前插重复目标时允许诚实更新代表来源；React 挂载身份按去重及最终覆盖前的完整目标组排序生成，并补齐 workspace identity、remote session、session、epoch、turn，不包含被选中来源的位置。
- 五件套与公开 index 只依赖 shared 类型与纯媒体格式注册表；本模块属于共享只读时间线的安全依赖闭包。
- 原历史、最终正文 action、预览卡片验证和 scoped 打开均由既有 renderer/hook 继续拥有。
- 单 URL text fence 保留原代码块，由消费方原生按钮将完整 target 直接交给既有打开回调，禁止手拼 Markdown 改写目标。
- 同 row 相交的 context 区间合并为原文切片，首引用 key/start/end/target 保持锚点；不跨 row 拼接。最终覆盖对整组合并目标判断，全部覆盖才省略；textFenceTargets 保留所有未被最终正文覆盖的完整目标并去重，按钮以目标作 key。该数组可选，旧的单 fence 引用仍可由 sourceFormat/target 渲染打开动作。
- 提取阶段保留全部有效来源引用，先形成原段完整目标集合/首锚，再按来源顺序省略目标全被已展示来源或最终正文覆盖的组；部分覆盖保留原文和原始目标组。identityTargets 只为纯派生完整目标集合，省略时兼容单 target；不新增可写代表缓存或持久化状态。

- UX06 `buildConversationMcpGroups` 是只读连续投影：保留非成员行及原生父子身份，专用 Node REPL/CUA/插件交互不接管。同服务组只能跨相邻同 turn、同 parent 的 MCP 行。
- 服务比较使用完整身份而非展示短名：discovery 的完整配置 serverName 与 legacy 未缩短 encoded server 段分别处于独立身份域。旧 envelope 无法无损映射 discovery 键，跨来源保守断组，允许混合格式的真实同服务多一组；不猜标签、不新增映射缓存，既有机械短名显示不变。
- UX06 `resolveConversationDisclosureKeys` 纯身份构造隔离 workspace/remote/session/epoch/turn/类型/调用；`disclosure.tsx` 为独立 UI 公开入口，存且仅存手动 override，暴露订阅供内层折叠与外层历史提升共用。纯 index 不导出 React 或可写状态。
- 连续组成员作为 override 别名，按最后手动意图恢复前插/增量后的组；组与子项 namespace 独立。默认态由当前投影派生，手动 override 始终优先。外层提升相关手动打开/失败项，不扩大无关历史。

- MCP 历史只接受三个 `__` 分段的显式 envelope；renderer 与纯分组共用同一机械 legacy presentation reader，避免插件路由命名在新组摘要中重新外露。
- MCP 失败从 canonical `output.display.isError`（仅 true）、旧 `display.ui.isError`、明确 error 状态/标签派生，不猜正文。该标记沿原 MCP result/display/metadata/live/cold owner 传递，不改变 V4 执行 success。旧无字段普通 MCP 历史不追溯推断。
