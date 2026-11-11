/**
 * 中继启动入口。环境变量：
 *   RELAY_HOST_TOKEN  必填，桌面端「中继令牌」
 *   RELAY_PORT        监听端口，默认 8787
 *   RELAY_BIND        监听地址，默认 127.0.0.1（由反向代理提供 HTTPS）
 *   RELAY_STATIC_DIR  手机网页目录，可选
 *   RELAY_TRUST_PROXY 设为 1 时按 X-Forwarded-For 最后一跳识别客户端（部署在自己的反向代理之后）
 */
import { createRelayServer } from "./index.js";

function log(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  if (level === "warn") console.warn(line);
  else console.log(line);
}

const hostToken = process.env["RELAY_HOST_TOKEN"]?.trim() ?? "";
if (hostToken.length < 16) {
  log("warn", "RELAY_HOST_TOKEN 未设置或少于 16 个字符，拒绝启动");
  process.exit(1);
}
const port = Number(process.env["RELAY_PORT"]) || 8787;
const bind = process.env["RELAY_BIND"]?.trim() || "127.0.0.1";
const staticDir = process.env["RELAY_STATIC_DIR"]?.trim() || undefined;
const trustProxy = process.env["RELAY_TRUST_PROXY"]?.trim() === "1";

const server = createRelayServer({
  hostToken,
  ...(staticDir ? { staticDir } : {}),
  trustProxy,
  logger: { info: (m, f) => log("info", m, f), warn: (m, f) => log("warn", m, f) },
});
server.listen(port, bind, () => {
  log("info", "relay listening", { bind, port, staticDir: staticDir ?? null, trustProxy });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
