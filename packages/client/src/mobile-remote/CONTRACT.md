# mobile-remote-client

手机网页的连接适配器：中继 WebSocket → Noise XX 握手 → `welcome` → 选窗口 → `attach` → 把加密通道包装成 `IMessagePassingProtocol`，交给 `ChannelClient` / `RemoteServiceAccess`。规则见 [手机远控](../../../../docs/desktop/mobile-remote-spec.md)。

不变量：

- `bindProtocol`（以及 `connectMobileRemote` 内部的 ChannelClient）在发送 `attach` 之前同步创建，保证不丢 Host 的 Initialize。
- 只在收到与所选窗口一致的 `attached` 后 resolve；此前的任何失败都以 `MobileRemoteConnectError` reject。
- 接入后两个心跳周期收不到 `pong` 主动断开；断线只经 `onClose` 通知，重连与 UI 状态归手机外壳。
- `lookupMobileRemotePairing` 只做配对码 → hostId 查询（只发送哈希），不握手；配对码是否有效最终由主机在握手中判定。
- 不缓存会话数据、不排队待发送命令；断线后由新的 attachment 订阅快照恢复。
