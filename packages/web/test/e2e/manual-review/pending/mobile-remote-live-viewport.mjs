/** 真实桌面接入的移动布局候选：只填写浏览器草稿，绝不点击发送。 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocket } from "ws";
import { chromium, webkit } from "playwright-core";
import { bytesToBase64Url, generateNoiseKeyPair } from "@zcode/shared/mobile-remote";

assert.equal(
  process.env.ZCODE_E2E_MANUAL_REVIEW,
  "1",
  "仅允许显式人工验收，需在线桌面开发窗口，不发送模型消息",
);
const publicMode = process.env.MOBILE_VIEWPORT_LIVE_PUBLIC === "1";
assert.ok(process.env.MOBILE_VIEWPORT_RELAY_URL, "需显式指定验收中继地址");
const mobileUrl = new URL("/m/", process.env.MOBILE_VIEWPORT_RELAY_URL).href;
const artifacts = resolve(".tmp/mobile-remote-viewport-e2e/live");
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const targets = await (await fetch("http://localhost:9229/json/list")).json();
const target = targets.find(
  (item) => item.type === "page" && item.url.startsWith("http://localhost:5174/"),
);
assert.ok(target, "必须是当前工作区的桌面开发窗口");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
let nextId = 0;
const pending = new Map();
socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.id) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
async function desktop(expression) {
  const id = ++nextId;
  const response = new Promise((resolve) => pending.set(id, resolve));
  socket.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  const message = await response;
  assert.ok(!message.error && !message.result.exceptionDetails, "桌面 API 调用失败");
  return message.result.result.value;
}
const initial = await desktop("window.zcode.getMobileRemoteStatus()");
assert.equal(initial.relay, "online");
const originalIds = initial.devices.map((item) => item.id).sort();
const results = [];
try {
  for (const [engine, browserType] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const key = generateNoiseKeyPair();
    const deviceId = bytesToBase64Url(key.publicKey);
    const browser = await browserType.launch({
      ...(engine === "chromium" ? { channel: "msedge" } : {}),
      headless: true,
    });
    const context = await browser.newContext({
      locale: "zh-CN",
      isMobile: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript((secret) => {
      localStorage.setItem(
        "zcode-mobile-remote:v1",
        JSON.stringify({ deviceSecret: secret, hosts: [] }),
      );
      const viewport = Object.assign(new EventTarget(), {
        height: innerHeight,
        width: innerWidth,
        offsetTop: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      window.__setTestViewport = (values) => {
        Object.assign(viewport, values);
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      };
    }, bytesToBase64Url(key.secretKey));
    if (!publicMode) {
      await page.route(`${mobileUrl}**`, async (route) => {
        const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(3));
        const root = resolve("packages/web/dist-mobile");
        const file = resolve(root, relative || "index.html");
        assert.ok(file.startsWith(root + "/"));
        const contentType =
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".html": "text/html",
            ".png": "image/png",
            ".svg": "image/svg+xml",
            ".webmanifest": "application/manifest+json",
            ".woff2": "font/woff2",
            ".json": "application/json",
          }[extname(file)] || "application/octet-stream";
        await route.fulfill({ status: 200, contentType, body: await readFile(file) });
      });
    }
    try {
      const ticket = await desktop("window.zcode.createMobileRemotePairing()");
      await page.goto(mobileUrl);
      await page.getByRole("textbox", { name: /配对码，如/ }).fill(ticket.code);
      await page.getByRole("button", { name: "配对", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector("#root > div.relative.h-full.w-full") ||
          document.querySelector("main h2")?.textContent === "选择要接入的窗口",
      );
      const windows = page.getByRole("heading", { name: "选择要接入的窗口" });
      if (await windows.isVisible())
        await windows.locator("..").getByRole("button").first().click();
      const input = page.locator('[contenteditable="true"]:visible').first();
      await input.waitFor();
      const scenarios = [
        { name: "portrait", width: 390, height: 844, visible: 844, top: 0 },
        { name: "keyboard", width: 390, height: 844, visible: 430, top: 52 },
        { name: "narrow-keyboard", width: 360, height: 800, visible: 430, top: 0 },
        { name: "landscape-keyboard", width: 844, height: 390, visible: 230, top: 0 },
        { name: "landscape-long-input", width: 844, height: 390, visible: 230, top: 0 },
        { name: "restored", width: 390, height: 844, visible: 844, top: 0 },
      ];
      for (const scenario of scenarios) {
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await page.evaluate(
          ({ height, top }) => window.__setTestViewport({ height, offsetTop: top }),
          { height: scenario.visible, top: scenario.top },
        );
        await input.fill(
          scenario.name === "landscape-long-input"
            ? Array.from(
                { length: 12 },
                (_, index) => `E2E_MOBILE_VIEWPORT_DRAFT 第 ${index + 1} 行`,
              ).join("\n")
            : "E2E_MOBILE_VIEWPORT_DRAFT 中文输入\n第二行",
        );
        await page.waitForFunction(
          ({ height, top, width }) => {
            const rect = document.getElementById("root").getBoundingClientRect();
            return (
              Math.abs(rect.height - height) <= 1 &&
              Math.abs(rect.y - top) <= 1 &&
              Math.abs(rect.width - width) <= 1
            );
          },
          { height: scenario.visible, top: scenario.top, width: scenario.width },
        );
        const metrics = await page.evaluate(() => {
          const box = (element) => {
            const r = element.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              bottom: r.bottom,
              right: r.right,
            };
          };
          const input = [...document.querySelectorAll('[contenteditable="true"]')].find(
            (element) =>
              element.getBoundingClientRect().width > 0 &&
              element.getBoundingClientRect().height > 0,
          );
          const send = input
            .closest('[data-testid="v4-composer"]')
            .querySelector('[data-testid="v4-composer-send"]');
          return {
            root: box(document.getElementById("root")),
            frame: box(document.querySelector('[data-desktop-window-frame="true"]')),
            editor: box(input),
            fontSize: parseFloat(getComputedStyle(input).fontSize),
            send: send ? box(send) : null,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        results.push({ engine, scenario: scenario.name, publicMode, ...metrics });
        assert.ok(metrics.fontSize >= 16, "聊天框必须使用安全字号");
        assert.equal(metrics.overflow, false, "业务 Root 不得横向溢出");
        assert.ok(metrics.frame.height <= metrics.root.height + 1, "业务窗口不得被独立 dvh 撑开");
        assert.ok(
          metrics.editor.y >= metrics.root.y && metrics.editor.bottom <= metrics.root.bottom + 1,
          "聊天输入区应处于可见视口内",
        );
        assert.ok(
          metrics.send &&
            metrics.send.y >= metrics.root.y &&
            metrics.send.bottom <= metrics.root.bottom + 1 &&
            metrics.send.right <= scenario.width + 1,
          "发送按钮应处于可见视口内",
        );
        await page.screenshot({
          path: resolve(
            artifacts,
            `${publicMode ? "public" : "local"}-${engine}-${scenario.name}.png`,
          ),
        });
        console.log(`${engine}-${scenario.name}: passed`);
      }
      await input.fill("");
      assert.deepEqual(errors, [], "真实 Root 不得出现未处理异常");
    } catch (error) {
      await page.screenshot({
        path: resolve(artifacts, `${publicMode ? "public" : "local"}-${engine}-failed.png`),
      });
      throw error;
    } finally {
      await desktop(`window.zcode.revokeMobileRemoteDevice(${JSON.stringify(deviceId)})`);
      await context.close();
      await browser.close();
    }
  }
} finally {
  const final = await desktop("window.zcode.getMobileRemoteStatus()");
  const preserved = originalIds.every((id) => final.devices.some((device) => device.id === id));
  socket.close();
  await writeFile(
    resolve(artifacts, `${publicMode ? "public" : "local"}-results.json`),
    JSON.stringify({ originalDevicesPreserved: preserved, results }, null, 2),
  );
  assert.ok(preserved, "必须保留原有配对设备");
  console.log(`实际桌面接入：${results.length} 组布局，原有设备已保留`);
}
