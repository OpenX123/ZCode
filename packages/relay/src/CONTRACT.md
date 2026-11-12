# mobile-remote-relay

手机远控的自托管中继。路由、限额与关闭码见 [手机远控](../../../docs/desktop/mobile-remote-spec.md)「中继」一节。

不变量：

- 只转发字节：内容是 Noise 密文，中继不解析、不落盘，日志只记录 hostId 前 8 位、connId、时长与字节数。
- 主机注册 `/v1/host` 与 `/v1/accept` 需要令牌（常量时间比较，错误以 HTTP 401 拒绝升级）；手机 `/v1/connect` 无需令牌。
- 同一 hostId 新注册替换旧控制连接（4409）；accept 超时 4408；单主机并发上限 4429；主机离线 4404。
- accept 前手机发出的字节（握手第 1 条）先缓存，上限 64 KiB，accept 后按序冲刷。
- 配对码查询：主机控制连接上的 `pairing-offer` / `pairing-clear` 维护「lookup → hostId」，每台主机最多一条，最长 10 分钟，控制连接断开即清除；`GET /v1/pair/<lookup>` 命中 200、未命中 404，同一客户端每分钟未命中超限 429（`trustProxy` 时按 `X-Forwarded-For` 最后一跳计客户端）。中继只见到配对码哈希，不记录 lookup。
- `close()` 先断开全部 WebSocket 与空闲 HTTP 连接再关闭监听，保证主机能立即感知中继下线。
- 静态文件只在 staticDir 内解析，防止路径穿越；HTML 不缓存，带 hash 资源长期缓存。
