# Source Server 操作日志

`SourceServerOperationLogs` 是 Host 连接与更新的唯一日志历史 owner。实现与公开类路径保留在 `../sourceServerOperationLogs.ts`；合同只描述原实例，不创建第二份缓存或转发服务。该 adapter 依赖 shared 的日志校验/脱敏、rpc 的事件、server 的 TransportContext，以及同 Host desktop 域的 resolver 来源 reader。

`run` 由 manager 在既有操作入口调用，为 Source（未识别时为 Profile）开启新代次，替换上一操作日志。任务只通过传入 context 上报日志；最新同 phase 进度替换旧进度，历史最多保留 100 条。成功以实际握手返回的 Source/Profile 绑定历史；失败保留领域 Error 身份与公共错误码，正文和日志沿原已知秘密脱敏，非可信错误不能携带本机缓存恢复保留字段。私有 resolver locator 不进入日志或复制文本。

```text
manager 操作 → 唯一日志 owner 开启代次 → context.onLog → 脱敏/strict 日志 → 事件与 read
                        ├─ 新操作替换 → 旧 onLog 不再写入当前历史
                        └─ 操作完成 → context.onLog 失效
```

`read` 返回当前历史的克隆；Renderer 事件只使查询失效，不成为第二日志 owner。`removeProfile` 删除该 Profile 关联，无其他 Profile 引用时清除对应历史。`dispose` 清除历史和事件。操作取消/删除的终态仍由 manager 拥有：调用方先撤销在途操作再 remove/dispose；本日志实例不另建取消队列，不承诺替代 manager 的迟到任务结果防护。

本模块的精确 roots 仅为该合同目录和既有实现文件，层为 adapters、owner 为 remote；不纳管整个 Host、不移动实现。真实行为验收覆盖 run/read、脱敏、代次替换、迟到回调、删除与释放；可信 resolver Error 和跨 RPC 行为由桌面现有专项回归共同证明。
