# mobile-remote-gateway

Electron Main 中的手机远控网关：维持到自托管中继的控制连接，为每条手机连接完成 Noise 握手与设备鉴权，再以 `web-remote-replayable` attachment 接入选定窗口的 Host 并双向转发。规则见 [手机远控](../../../../../docs/desktop/mobile-remote-spec.md)。

不变量：

- 唯一所有者：主机密钥、中继配置、设备列表落盘于 `<userData>/mobile-remote/state.json`（0600，原子写，串行化）；配对码只在内存，一次性、默认 10 分钟。
- 配对码：8 位，二维码与手输共用；生成即作废旧码并向中继登记哈希（`pairing-offer`），配对成功、过期、累计 5 次校验失败或配置变化时作废并撤销登记；中继重连后重新登记仍有效的码。
- 只转发：解密后的每条 RPC 原样 `postMessage` 到 Host 端口，反向同理；不缓存、不改写、不排队业务消息。
- 顺序：握手 → 鉴权 → `welcome` → `attach` → 挂好端口转发 → `attached`；`attach` 前收到 RPC 视为协议错误断开。
- 生命周期：Host 端口关闭 → 关闭手机连接（4410）；手机断开 → 关闭端口并 `DetachServicePort`；撤销设备 → 立即断开（4403）；关闭开关 → 断开中继与全部手机连接。
- 配置代际：配置变化后旧中继连接的回调一律忽略；中继令牌错误（401）不自动重试。
- 背压：WebSocket 发送缓冲超过 4 MiB 向 Host 发 `saturated`，降到 512 KiB 后发 `drained`。
