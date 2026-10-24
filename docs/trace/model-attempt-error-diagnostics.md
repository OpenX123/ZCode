# 模型失败的本地因果链诊断

状态：2026-10-24 独立桌面版本。原 `model_attempt` span、`error.cause.*` OTel 属性和 ARMS 查询已退役；保留真实错误包装及本地排查所需的因果关系。

## 保留的合同

`apps/zcode-cli/packages/adapters/src/model/runner-retry.ts` 中的 `TerminalStreamChunkError` 保留原 `adapterError`，并以 `adapterError.cause ?? adapterError` 暴露 `cause`。这样流式错误被包装后，已有分类器与本地调试仍能找到底层网络异常。

- 保留原 message、adapterError 身份及既有重试行为，不因诊断而改变模型选择或请求内容。
- `cause` 是可选证据，不把普通 Error、自引用或缺失字段伪造成已知根因。
- 需要查看包装链时采用有界遍历与循环检测，不递归扫描任意对象属性。
- 本地错误详情和日志复用现有脱敏边界，不添加自动上传、导出队列或官方查询服务。
- 流式使用量、finish reason 与部分工具输入仍属于运行时事实，不能以删除遥测为由改变其处理。

排查时结合请求失败阶段、受控异常类型、HTTP 状态及本地关联值；只有独立证据才能区分 DNS、TLS、连接重置或 Provider 拒绝。裸 `Model request failed.` 或 `terminated` 不足以证明根因。

相关产品行为见[对话错误展示](chat-error-banner-attribution.md)，本地数据入口见[诊断索引](README.md)。
