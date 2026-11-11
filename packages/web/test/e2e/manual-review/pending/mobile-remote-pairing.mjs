// 手机配对候选验收：真实生产网页、中继、网关和 Noise 握手；停在隔离窗口选择页。
// 先运行 pnpm --filter @zcode/web build:mobile，再用 pnpm exec tsx 执行本文件。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import QRCode from "qrcode";
import { createRelayServer } from "../../../../../relay/src/index.ts";
import { mobileRemotePairingLookupKey } from "@zcode/shared/mobile-remote";
// 测试夹具只装配无 Electron 依赖的网关与存储，避免启动用户桌面或读取真实配置。
import { createMobileRemoteGateway } from "../../../../../desktop/src/main/mobile-remote/mobileRemoteGateway.ts";
import { createMobileRemoteStore } from "../../../../../desktop/src/main/mobile-remote/mobileRemoteStore.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const staticDir = resolve(root, "packages/web/dist-mobile");
await access(join(staticDir, "index.html"));
const artifactRoot = resolve(root, ".tmp/mobile-remote-pairing-e2e");
await mkdir(artifactRoot, { recursive: true });
const artifacts = await mkdtemp(
  join(artifactRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-`),
);
const browser = await chromium.launch({
  channel: process.env.MOBILE_PAIRING_E2E_BROWSER || "msedge",
  headless: true,
});
const results = [];
const configurations = [
  { locale: "zh-CN", theme: "light", width: 390 },
  { locale: "en-US", theme: "dark", width: 390 },
];
const selectedCase = process.env.MOBILE_PAIRING_E2E_CASE;

async function eventually(read) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await read();
    if (result) return result;
    assert.ok(Date.now() < deadline, "等待隔离中继或网关状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture(configuration, id) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-mobile-pairing-"));
  const token = randomBytes(32).toString("base64url");
  const relay = createRelayServer({ hostToken: token, staticDir, pairingMissesPerMinute: 2 });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${relay.address().port}`;
  const gateway = createMobileRemoteGateway({
    store: createMobileRemoteStore(dir),
    hostName: () => "E2E_MOBILE_PAIRING_HOST",
    listWindows: () => [
      { windowId: 1, title: "E2E_WINDOW_ONE", focused: true },
      { windowId: 2, title: "E2E_WINDOW_TWO", focused: false },
    ],
    attachWindow: () => {
      throw new Error("配对用例不得接入业务 Host");
    },
    logger: { info() {}, warn() {} },
  });
  const context = await browser.newContext({
    locale: configuration.locale,
    colorScheme: configuration.theme,
    viewport: { width: configuration.width, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript((theme) => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.classList.add(theme === "dark" ? "zai-dark" : "zai-light");
    });
  }, configuration.theme);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const requests = { lookups: 0, decoders: 0, sockets: 0 };
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/pair/")) requests.lookups++;
    if (/\/jsQR-[^/]+\.js$/.test(path)) requests.decoders++;
  });
  page.on("websocket", () => requests.sockets++);
  await gateway.start();
  await gateway.setConfig({ enabled: true, relayUrl: origin, relayToken: token });
  await eventually(() => gateway.getStatus().relay === "online");
  const ticket = gateway.createPairing();
  const lookup = `${origin}/v1/pair/${mobileRemotePairingLookupKey(ticket.code)}`;
  await eventually(async () => (await fetch(lookup)).ok);
  const zh = configuration.locale === "zh-CN";
  const input = page.getByRole("textbox", { name: /配对码，如|Pairing code, e.g./ });
  const pair = page.getByRole("button", { name: zh ? "配对" : "Pair", exact: true });
  const scan = page.getByRole("button", { name: zh ? "扫码" : "Scan", exact: true });

  async function submit(value = ticket.code) {
    await input.fill(value);
    await pair.click();
  }
  async function paired() {
    await page.getByRole("button", { name: /E2E_WINDOW_ONE/ }).waitFor();
    assert.equal(gateway.getStatus().devices.length, 1);
    await eventually(async () => (await fetch(lookup)).status === 404);
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  async function camera(mode) {
    const qr = await QRCode.toDataURL(ticket.url, { width: 640, margin: 4 });
    await page.addInitScript(
      ({ mode, qr, pairingUrl }) => {
        window.__pairingCamera = { calls: 0, tracks: [], detectorCalls: 0 };
        Object.defineProperty(window, "BarcodeDetector", {
          configurable: true,
          value:
            mode === "native"
              ? class {
                  static async getSupportedFormats() {
                    return ["qr_code"];
                  }
                  async detect() {
                    window.__pairingCamera.detectorCalls++;
                    return [{ rawValue: pairingUrl }];
                  }
                }
              : undefined,
        });
        if (mode === "unavailable") {
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: undefined,
          });
          return;
        }
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: async () => {
            window.__pairingCamera.calls++;
            if (mode === "denied" || mode === "never") {
              if (mode === "denied") throw new DOMException("E2E_CAMERA_DENIED", "NotAllowedError");
              await new Promise((resolve) => {
                window.__releasePairingCamera = resolve;
              });
            }
            const image = new Image();
            image.src = qr;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 640;
            canvas.getContext("2d").drawImage(image, 0, 0);
            const stream = canvas.captureStream(5);
            window.__pairingCamera.tracks.push(...stream.getTracks());
            return stream;
          },
        });
        if (mode === "play-failure") {
          HTMLMediaElement.prototype.play = () =>
            Promise.reject(new DOMException("E2E_VIDEO_FAILURE", "NotSupportedError"));
        }
      },
      { mode, qr, pairingUrl: ticket.url },
    );
  }
  return {
    page,
    ticket,
    origin,
    errors,
    requests,
    input,
    scan,
    pair,
    submit,
    paired,
    camera,
    open: (url = `${origin}/m/`) => page.goto(url),
    async alert(pattern) {
      await page.getByRole("alert").filter({ hasText: pattern }).waitFor();
      await page.screenshot({
        path: join(artifacts, `${id}-${configuration.locale}-${configuration.theme}-alert.png`),
        fullPage: true,
      });
    },
    async stopped() {
      await page.waitForFunction(
        () =>
          window.__pairingCamera.tracks.length > 0 &&
          window.__pairingCamera.tracks.every((track) => track.readyState === "ended"),
      );
    },
    async close() {
      await context.close();
      gateway.dispose();
      await new Promise((resolve) => relay.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const cases = {
  "MRP-01": async (h) => {
    await h.camera("denied");
    await h.open();
    await h.input.fill(h.ticket.code.toLowerCase().replace("-", " "));
    assert.equal(await h.input.inputValue(), h.ticket.code);
    await h.pair.click();
    await h.paired();
    assert.equal(h.requests.lookups, 1);
    assert.equal(await h.page.evaluate(() => window.__pairingCamera.calls), 0);
    assert.equal(h.requests.decoders, 0);
  },
  "MRP-02": async (h) => {
    await h.camera("denied");
    await h.open();
    await h.scan.click();
    await h.alert(/没有摄像头权限|Camera access was denied/);
    await h.submit();
    await h.paired();
  },
  "MRP-03": async (h) => {
    await h.camera("unavailable");
    await h.open();
    await h.scan.click();
    await h.alert(/无法使用摄像头|camera is not available/);
    await h.submit();
    await h.paired();
  },
  "MRP-04": async (h) => {
    await h.camera("fallback");
    await h.open();
    assert.equal(h.requests.decoders, 0);
    await h.scan.click();
    await h.paired();
    await h.stopped();
    assert.equal(h.requests.decoders, 1);
    assert.equal(h.requests.lookups, 0);
  },
  "MRP-05": async (h) => {
    await h.camera("native");
    await h.open();
    await h.scan.click();
    await h.paired();
    await h.stopped();
    assert.ok(await h.page.evaluate(() => window.__pairingCamera.detectorCalls > 0));
    assert.equal(h.requests.decoders, 0);
  },
  "MRP-06": async (h) => {
    await h.open();
    await h.submit("abcd");
    await h.alert(/无法识别|Not recognized/);
    await h.submit(h.ticket.url.replace(h.origin, "https://other-relay.invalid"));
    await h.alert(/其他中继服务器|different relay server/);
    assert.equal(h.requests.lookups, 0);
    assert.equal(h.requests.sockets, 0);
    await h.submit();
    await h.paired();
  },
  "MRP-07": async (h) => {
    await h.open();
    await h.submit(h.ticket.url);
    await h.paired();
    assert.equal(h.requests.lookups, 0);
  },
  "MRP-08": async (h) => {
    await h.open();
    for (let i = 0; i < 3; i++) {
      await h.submit("00000000" === h.ticket.code.replace("-", "") ? "11111111" : "00000000");
      await h.alert(i < 2 ? /无效或已过期|invalid or expired/ : /尝试次数过多|Too many attempts/);
    }
    assert.equal(h.requests.lookups, 3);
    assert.equal(h.requests.sockets, 0);
  },
  "MRP-09": async (h) => {
    await h.camera("fallback");
    await h.page.route("**/jsQR-*.js", (route) => route.abort());
    await h.open();
    await h.scan.click();
    await h.alert(/无法使用摄像头|camera is not available/);
    await h.stopped();
    await h.submit();
    await h.paired();
  },
  "MRP-10": async (h) => {
    await h.camera("play-failure");
    await h.open();
    await h.scan.click();
    await h.alert(/无法使用摄像头|camera is not available/);
    await h.stopped();
    await h.submit();
    await h.paired();
  },
  "MRP-11": async (h) => {
    await h.camera("never");
    await h.open();
    await h.scan.click();
    await h.page.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
    await h.page.evaluate(() => window.__releasePairingCamera());
    await h.stopped();
    assert.equal(h.requests.decoders, 0);
    assert.equal(await h.page.getByRole("alert").count(), 0);
    await h.submit();
    await h.paired();
  },
  "MRP-12": async (h) => {
    await h.open(h.ticket.url);
    await h.paired();
    assert.equal(h.requests.lookups, 0);
  },
};

try {
  for (const configuration of configurations) {
    for (const [id, run] of Object.entries(cases)) {
      if (selectedCase && id !== selectedCase) continue;
      const h = await fixture(configuration, id);
      const label = `${id}-${configuration.locale}-${configuration.theme}`;
      try {
        await run(h);
        assert.deepEqual(h.errors, [], "浏览器不得出现未处理异常");
        await h.page.screenshot({ path: join(artifacts, `${label}.png`), fullPage: true });
        results.push({ id, ...configuration, result: "passed", requests: h.requests });
        console.log(`${label}: passed`);
      } catch (error) {
        await h.page.screenshot({ path: join(artifacts, `${label}-failed.png`), fullPage: true });
        results.push({ id, ...configuration, result: "failed", browserErrors: h.errors });
        throw error;
      } finally {
        await h.close();
      }
    }
  }
} finally {
  await writeFile(join(artifacts, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await browser.close();
  console.log(
    `配对浏览器验收：${results.filter((result) => result.result === "passed").length}/${results.length}；产物 ${artifacts}`,
  );
}
