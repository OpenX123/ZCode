# subagent-runtime-config

Host 文件配置缓存的最小 adapters 边界，由 conversation 维护。仅包含既有缓存与监听 scope，
不接管 subagents service 或 CLI；本次路径迁移不改变行为。公开入口为 index.ts 的工厂与
contract.ts 的 reader、workspace、缓存类型；scope 是内部实现。

- Local Host subagents service 持有缓存实例，缓存唯一持有共享用户/state、按 identity/path
  隔离的项目范围和完整 snapshot；scope 唯一持有 pending、串行加载与取消信号。
- prepare/read 保留异步及现有有界初始化等待；prepare 不带 workspace 时重载共享范围，
  带 workspace 时准备该项目。后台事件、失败回退、取消和迟到隔离仍由原实现负责。
- read 只返回完整 snapshot 的 structuredClone；未准备或已销毁时拒读。dispose 幂等，
  取消加载并关闭监听，不写入配置、不广播公共事件。
- shared 提供解析器和协议类型，services 只复用既有 serviceLogger。文件事件 → scope 串行
  加载 → 缓存发布 → service RPC 的顺序及详细 I/O 合同见 docs/subagent-runtime-refresh.md。

contract.test.ts 经公开工厂和临时文件 reader 验证生命周期及副本隔离；原缓存 mock 测试和
原 native watcher 整文件继续验证增量、取消与真实文件事件行为。
