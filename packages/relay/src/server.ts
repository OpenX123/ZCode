/**
 * 手机远控自托管中继。职责只有两件：
 * 1. 把手机连接与桌面主机连接逐字节对接（内容是 Noise 密文，中继无法解读）；
 * 2. 托管手机网页静态文件（/m/）；
 * 3. 保存主机登记的配对码查询键（lookup → hostId），供手机手输配对码时查询。
 * 协议与限额见 docs/desktop/mobile-remote-spec.md「中继」一节。
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { RelayCloseCodes, type RelayOptions } from "./contract.js";

const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONN_ID_PATTERN = /^[0-9a-f-]{36}$/;
/** 配对码查询键 = base64url(SHA-256)，固定 43 位 */
const LOOKUP_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAIR_ROUTE_PREFIX = "/v1/pair/";

interface PendingConnection {
  phone: WebSocket;
  buffered: Buffer[];
  bufferedBytes: number;
  timer: ReturnType<typeof setTimeout>;
}

interface HostEntry {
  control: WebSocket;
  pending: Map<string, PendingConnection>;
  /** 已对接的手机连接，用于并发上限统计与主机替换时清理 */
  active: Set<WebSocket>;
  /** 当前登记的配对码查询键，每台主机最多一条 */
  pairingLookup?: string;
}

interface PairingOffer {
  hostId: string;
  expiresAt: number;
}

/** 主机控制连接上的配对登记消息；格式不对返回 null（忽略，不断开）。 */
function parseHostControlMessage(
  raw: RawData,
): { type: "pairing-offer"; lookup: string; expiresAt: number } | { type: "pairing-clear" } | null {
  let message: unknown;
  try {
    message = JSON.parse(toBuffer(raw).toString("utf8"));
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const { type, lookup, expiresAt } = message as Record<string, unknown>;
  if (type === "pairing-clear") return { type };
  if (
    type === "pairing-offer" &&
    typeof lookup === "string" &&
    LOOKUP_PATTERN.test(lookup) &&
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt)
  ) {
    return { type, lookup, expiresAt };
  }
  return null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(expected: string, actual: string | null): boolean {
  if (!expected || !actual) return false;
  return timingSafeEqual(digest(expected), digest(actual));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** WebSocket 只允许转发 1000 与 3000-4999 关闭码，其他码统一换成 peerClosed。 */
function forwardableCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : RelayCloseCodes.peerClosed;
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return;
  ws.close(code, reason.slice(0, 120));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

async function serveStatic(
  staticDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const root = resolve(staticDir);
  const relative = decodeURIComponent(pathname.replace(/^\/m\/?/, ""));
  const candidate = normalize(join(root, relative));
  // 路径必须落在 staticDir 内，防止 ../ 穿越。
  const insideRoot = candidate === root || candidate.startsWith(root + sep);
  let filePath = insideRoot ? candidate : join(root, "index.html");
  let fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || fileStat.isDirectory()) {
    // SPA 回退：未知路径交给 index.html。
    filePath = join(root, "index.html");
    fileStat = await stat(filePath).catch(() => null);
  }
  if (!fileStat) {
    res.writeHead(404).end("not found");
    return;
  }
  const isHtml = filePath.endsWith(".html");
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "content-length": fileStat.size,
    // 入口 HTML 不缓存，保证升级后手机拿到新版本；带 hash 的资源长期缓存。
    "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  createReadStream(filePath).pipe(res);
}

export function createRelayServer(options: RelayOptions): Server {
  const logger = options.logger ?? { info: () => {}, warn: () => {} };
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 10_000;
  const maxConnectionsPerHost = options.maxConnectionsPerHost ?? 8;
  const maxMessageBytes = options.maxMessageBytes ?? 128 * 1024;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const maxPendingBytes = options.maxPendingBytes ?? 64 * 1024;
  const pairingMissesPerMinute = options.pairingMissesPerMinute ?? 10;
  const maxPairingTtlMs = options.maxPairingTtlMs ?? 10 * 60 * 1000;
  const hosts = new Map<string, HostEntry>();
  const offers = new Map<string, PairingOffer>();
  /** 配对码查询未命中计数：客户端地址 → 当前一分钟窗口 */
  const pairingMisses = new Map<string, { windowStart: number; count: number }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [lookup, offer] of offers) {
      if (offer.expiresAt <= now) offers.delete(lookup);
    }
    for (const [client, entry] of pairingMisses) {
      if (now - entry.windowStart >= 60_000) pairingMisses.delete(client);
    }
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, pingIntervalMs);
  heartbeat.unref();

  function track(ws: WebSocket): void {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  }

  function shortId(hostId: string): string {
    return hostId.slice(0, 8);
  }

  function clearPairing(entry: HostEntry): void {
    if (entry.pairingLookup) offers.delete(entry.pairingLookup);
    delete entry.pairingLookup;
  }

  function handleHostMessage(entry: HostEntry, hostId: string, raw: RawData): void {
    const message = parseHostControlMessage(raw);
    if (!message) return;
    clearPairing(entry);
    if (message.type === "pairing-clear") return;
    const expiresAt = Math.min(message.expiresAt, Date.now() + maxPairingTtlMs);
    if (expiresAt <= Date.now()) return;
    // 极小概率与其他主机的查询键冲突：后登记者覆盖，冲突一方握手时配对码校验失败，不会误配。
    offers.set(message.lookup, { hostId, expiresAt });
    entry.pairingLookup = message.lookup;
  }

  function clientKey(req: IncomingMessage): string {
    if (options.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const value = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
      // 取最后一跳：由自己的反向代理追加，客户端伪造的前缀不影响。
      const last = value?.split(",").pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function handlePairingLookup(req: IncomingMessage, res: ServerResponse, lookup: string): void {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    };
    const client = clientKey(req);
    const now = Date.now();
    let misses = pairingMisses.get(client);
    if (!misses || now - misses.windowStart >= 60_000) {
      misses = { windowStart: now, count: 0 };
      pairingMisses.set(client, misses);
    }
    if (misses.count >= pairingMissesPerMinute) {
      res.writeHead(429, { ...headers, "retry-after": "60" }).end('{"error":"rate_limited"}');
      return;
    }
    const offer = LOOKUP_PATTERN.test(lookup) ? offers.get(lookup) : undefined;
    if (!offer || offer.expiresAt <= now || !hosts.has(offer.hostId)) {
      misses.count += 1;
      res.writeHead(404, headers).end('{"error":"not_found"}');
      return;
    }
    res.writeHead(200, headers).end(JSON.stringify({ hostId: offer.hostId }));
  }

  function handleHost(ws: WebSocket, hostId: string): void {
    const previous = hosts.get(hostId);
    if (previous) {
      // 同一主机重复注册时以新连接为准（桌面重启、网络切换后旧连接可能仍半开）。
      hosts.delete(hostId);
      clearPairing(previous);
      safeClose(previous.control, RelayCloseCodes.hostReplaced, "replaced");
      for (const pending of previous.pending.values()) {
        clearTimeout(pending.timer);
        safeClose(pending.phone, RelayCloseCodes.hostOffline, "host reconnected");
      }
    }
    const entry: HostEntry = { control: ws, pending: new Map(), active: new Set() };
    hosts.set(hostId, entry);
    logger.info("host online", { host: shortId(hostId) });
    ws.on("message", (raw) => {
      // 控制连接上主机只发配对登记消息；其他内容忽略，保活靠 ping/pong。
      if (hosts.get(hostId) === entry) handleHostMessage(entry, hostId, raw);
    });
    ws.on("close", () => {
      if (hosts.get(hostId) !== entry) return;
      hosts.delete(hostId);
      clearPairing(entry);
      for (const pending of entry.pending.values()) {
        clearTimeout(pending.timer);
        safeClose(pending.phone, RelayCloseCodes.hostOffline, "host offline");
      }
      logger.info("host offline", { host: shortId(hostId) });
    });
  }

  function handleConnect(ws: WebSocket, hostId: string): void {
    const entry = hosts.get(hostId);
    if (!entry) {
      safeClose(ws, RelayCloseCodes.hostOffline, "host offline");
      return;
    }
    if (entry.pending.size + entry.active.size >= maxConnectionsPerHost) {
      safeClose(ws, RelayCloseCodes.tooManyConnections, "too many connections");
      return;
    }
    const connId = randomUUID();
    const pending: PendingConnection = {
      phone: ws,
      buffered: [],
      bufferedBytes: 0,
      timer: setTimeout(() => {
        entry.pending.delete(connId);
        safeClose(ws, RelayCloseCodes.acceptTimeout, "accept timeout");
      }, acceptTimeoutMs),
    };
    entry.pending.set(connId, pending);
    ws.on("message", (data) => {
      // accept 之前先缓存（手机会立刻发出握手第 1 条消息）；accept 后由 pipe 接管。
      if (!entry.pending.has(connId)) return;
      const buffer = toBuffer(data);
      pending.bufferedBytes += buffer.length;
      if (pending.bufferedBytes > maxPendingBytes) {
        entry.pending.delete(connId);
        clearTimeout(pending.timer);
        safeClose(ws, RelayCloseCodes.badRequest, "too much data before accept");
        return;
      }
      pending.buffered.push(buffer);
    });
    ws.on("close", () => {
      if (entry.pending.get(connId) === pending) {
        entry.pending.delete(connId);
        clearTimeout(pending.timer);
      }
    });
    entry.control.send(JSON.stringify({ type: "incoming", connId }));
  }

  function handleAccept(ws: WebSocket, hostId: string, connId: string): void {
    const entry = hosts.get(hostId);
    const pending = entry?.pending.get(connId);
    if (!entry || !pending) {
      safeClose(ws, RelayCloseCodes.badRequest, "unknown connection");
      return;
    }
    entry.pending.delete(connId);
    clearTimeout(pending.timer);
    const phone = pending.phone;
    if (phone.readyState !== phone.OPEN) {
      safeClose(ws, RelayCloseCodes.peerClosed, "phone closed");
      return;
    }
    entry.active.add(phone);
    phone.removeAllListeners("message");
    const startedAt = Date.now();
    let bytes = 0;
    for (const buffer of pending.buffered) {
      bytes += buffer.length;
      ws.send(buffer, { binary: true });
    }
    phone.on("message", (data) => {
      const buffer = toBuffer(data);
      bytes += buffer.length;
      if (ws.readyState === ws.OPEN) ws.send(buffer, { binary: true });
    });
    ws.on("message", (data) => {
      const buffer = toBuffer(data);
      bytes += buffer.length;
      if (phone.readyState === phone.OPEN) phone.send(buffer, { binary: true });
    });
    let closed = false;
    const closeBoth = (code: number, reason: Buffer) => {
      if (closed) return;
      closed = true;
      entry.active.delete(phone);
      const forwarded = forwardableCloseCode(code);
      safeClose(phone, forwarded, reason.toString());
      safeClose(ws, forwarded, reason.toString());
      logger.info("connection closed", {
        host: shortId(hostId),
        connId,
        durationMs: Date.now() - startedAt,
        bytes,
      });
    };
    phone.on("close", closeBoth);
    ws.on("close", closeBoth);
    logger.info("connection paired", { host: shortId(hostId), connId });
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname.startsWith(PAIR_ROUTE_PREFIX)) {
      handlePairingLookup(req, res, url.pathname.slice(PAIR_ROUTE_PREFIX.length));
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/" && options.staticDir) {
      res.writeHead(302, { location: "/m/" }).end();
      return;
    }
    if ((url.pathname === "/m" || url.pathname.startsWith("/m/")) && options.staticDir) {
      void serveStatic(options.staticDir, url.pathname, res).catch((error: unknown) => {
        logger.warn("static serve failed", { error: String(error) });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    res.writeHead(404).end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    const hostId = url.searchParams.get("host") ?? "";
    const route = url.pathname;
    if (!HOST_ID_PATTERN.test(hostId) || !route.startsWith("/v1/")) {
      socket.destroy();
      return;
    }
    const needsToken = route === "/v1/host" || route === "/v1/accept";
    if (needsToken && !tokenMatches(options.hostToken, url.searchParams.get("token"))) {
      // 令牌错误直接以 HTTP 401 拒绝升级，不暴露主机是否在线。
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const connId = url.searchParams.get("conn") ?? "";
    if (route === "/v1/accept" && !CONN_ID_PATTERN.test(connId)) {
      socket.destroy();
      return;
    }
    if (route !== "/v1/host" && route !== "/v1/connect" && route !== "/v1/accept") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      track(ws);
      ws.on("error", (error) => logger.warn("socket error", { route, error: error.message }));
      if (route === "/v1/host") handleHost(ws, hostId);
      else if (route === "/v1/connect") handleConnect(ws, hostId);
      else handleAccept(ws, hostId, connId);
    });
  });

  // Bugfix: http.Server 要等所有连接（含已升级的 WebSocket）结束才触发 "close"，
  // 原先在 "close" 事件里才断开 WebSocket，两者互相等待导致 close() 永远不返回、主机感知不到中继下线。
  // 改为调用 close() 时先断开所有 WebSocket 与空闲 HTTP 连接，再交给 http.Server 收尾。
  const closeHttpServer = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    closeHttpServer(callback);
    server.closeIdleConnections();
    return server;
  };

  return server;
}
