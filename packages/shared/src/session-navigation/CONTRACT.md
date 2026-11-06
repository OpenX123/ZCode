# 会话导航契约

SessionLocator 是已存在会话的持久定位坐标；路径用于执行，identity 用于隔离。buildSessionDeepLink 编码，parseSessionDeepLink 校验外部输入；两者均无 I/O，不创建会话、不信任新目录、不建立连接。Main 和 UI 复用同一格式，Host 仍需查询权威索引。临时 remoteSessionId、凭据和对话正文不得进入链接。
