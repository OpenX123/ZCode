# mobile-remote-link

手机远控的端到端加密链路：Noise_XX_25519_ChaChaPoly_SHA256 握手、握手后分帧、控制消息校验、配对链接编解码，以及 Main 网关与设置页之间的状态类型（`contract.ts`）。规则见 [手机远控](../../../../docs/desktop/mobile-remote-spec.md)。

不变量：

- 纯计算，无 IO：socket 由调用方提供（收到字节 → `receive`，`write` 回调发字节），浏览器与 Node 共用。
- 握手按 Noise rev34 编排，与 cacophony 测试向量逐字节一致；prologue 固定 `zcode-mobile-remote/v1`。
- 手机在发送第 3 条消息前校验主机静态公钥，配对码只会加密发给持有主机私钥的一方。
- 任何解密失败、乱序、重放、非法控制消息都抛 `NoiseError`，调用方必须断开连接，不能重试。
- 配对码是 8 位 Crockford Base32，二维码与手输共用；`normalizeMobileRemotePairingCode` 是唯一规范化入口，`mobileRemotePairingLookupKey` 是唯一的中继查询键算法。`parseMobileRemotePairingInput` 统一识别扫码结果、粘贴链接与手输码。
- 一条 RPC 消息 = 一次 `sendRpc`；超过单帧上限自动分片，接收端重组后整条投递。
