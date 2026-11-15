# conversation-presentation

Renderer 展示派生的唯一边界；输入是已经收到的 V4 行，输出是带来源区间的纯投影。

- 不写回行、协议、业务状态或媒体事实，不做网络、文件 IO，不持有服务。
- 成果只接纳明确闭合引用，保留完整目标和说明段落；代码和命令不会变为成果。
- 完整原段只展示一次；最终正文覆盖该段全部目标时省略，部分覆盖时保留完整原句，不能为删重裁剪上下文。
- 来源 key/range 描述实际选中来源，前插重复目标时允许诚实更新代表来源；React 挂载身份按去重及最终覆盖前的完整目标组排序生成，并补齐 workspace identity、remote session、session、epoch、turn，不包含被选中来源的位置。
- 五件套与公开 index 只依赖 shared 类型；本模块属于共享只读时间线的安全依赖闭包。
- 原历史、最终正文 action、预览卡片验证和 scoped 打开均由既有 renderer/hook 继续拥有。
- 单 URL text fence 保留原代码块，由消费方原生按钮将完整 target 直接交给既有打开回调，禁止手拼 Markdown 改写目标。
- 同 row 相交的 context 区间合并为原文切片，首引用 key/start/end/target 保持锚点；不跨 row 拼接。最终覆盖对整组合并目标判断，全部覆盖才省略；textFenceTargets 保留所有未被最终正文覆盖的完整目标并去重，按钮以目标作 key。该数组可选，旧的单 fence 引用仍可由 sourceFormat/target 渲染打开动作。
- 提取阶段保留全部有效来源引用，先形成原段完整目标集合/首锚，再按来源顺序省略目标全被已展示来源或最终正文覆盖的组；部分覆盖保留原文和原始目标组。identityTargets 只为纯派生完整目标集合，省略时兼容单 target；不新增可写代表缓存或持久化状态。
