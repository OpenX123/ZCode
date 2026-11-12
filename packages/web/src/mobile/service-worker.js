// 只增强安装与离线导航提示，不缓存远控页面、会话、配对码或 RPC。
globalThis.addEventListener("install", (event) => event.waitUntil(globalThis.skipWaiting()));
globalThis.addEventListener("activate", (event) => event.waitUntil(globalThis.clients.claim()));
globalThis.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#161616"><title>YCode</title>
<style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#161616;color:#f8f8f8;font:1rem system-ui}main{padding:2rem;max-width:28rem}h1{font-size:1.25rem}a{color:inherit}</style>
<main><h1>请连接网络 / Connect to the internet</h1>
<p>手机远控需要网络与在线的桌面窗口。<br>Remote control needs a network connection and an open desktop window.</p>
<a href="/m/">重新连接 / Reconnect</a></main></html>`,
          {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          },
        ),
    ),
  );
});
