# 会话工作树

执行 Host 的 Git 服务负责创建工作树，Host 会话编排消费只读 `getPreparation` 与 `prepare`／`rollback`。只读查询仅返回目录仍存在的 ready 操作，不创建目录或记录；它供 Host 在父会话后来 busy 时恢复同一已准备的操作。

固定源 HEAD 与原始文件快照，从原 HEAD 创建 `ycode/fork-<operationId>`，保持源文件和 index 不变；child 不继承暂存分类。目标不运行 hook、不复制忽略文件、不安装依赖。

同一仓库、同一操作持久幂等；只有 HEAD、分支、index 和文件指纹全部匹配时才可回滚。无法证明仍归本次操作所有的崩溃工件必须保留。详细状态、故障恢复与验收见 `docs/desktop/session-links-and-forks-spec.md`。
