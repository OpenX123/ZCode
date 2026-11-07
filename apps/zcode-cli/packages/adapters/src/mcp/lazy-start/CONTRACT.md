# cli-mcp-lazy-start

会话 MCP lease 的"首次使用时启动"与闲置回收。目的：首个模型请求不等待 MCP（1.0.5：p50 2.5s / p90 4.5s），常驻会话不长期保有插件宿主进程（本机 61 个、约 4.0GB）。规则见 [内置引擎性能规格](../../../../../../../docs/desktop/engine-performance-1.1-spec.md#1-mcp-不阻塞首个模型请求)。

不变量：

- 会话 lease 是连接与"待首次使用"登记的唯一 owner；本模块不持有连接，连接只经 lease 的 `acquire` / `release` 创建与释放，不跨 lease 共享状态。
- 工具清单缓存只保存指纹、server 名、保存时间与工具描述；env、header、OAuth 的值不参与指纹也不落盘。
- 同一 server 的首次连接单飞；调用方 `signal` 与 lease 关闭只结束等待，不取消底层连接。lease 关闭后不再创建连接。
- revision 只增不减：后台连接结束、清单漂移、首次启动失败递增；闲置回收并入被释放连接的 list_changed 计数。
- 闲置计时器全部 unref，server 释放与 lease 关闭时清除；在途使用或 MCP App 连接期间不回收。

```text
register → (命中) 待首次使用 ──ensureStarted──▶ acquire → connected ──闲置窗口──▶ release → 待首次使用
         → (未命中) 后台 acquire ──结束──▶ revision+1
```
