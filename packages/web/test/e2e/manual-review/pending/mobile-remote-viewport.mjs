/** 移动视口与安装候选：真实生产页，键盘由受控可见视口事件模拟，不能替代真机。 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, webkit } from "playwright-core";
import { createRelayServer } from "../../../../../relay/src/index.ts";

const artifactRoot = resolve(".tmp/mobile-remote-viewport-e2e");
await mkdir(artifactRoot, { recursive: true });
const artifacts = await mkdtemp(
  join(artifactRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-`),
);
const relay = createRelayServer({
  hostToken: randomBytes(32).toString("base64url"),
  staticDir: resolve("packages/web/dist-mobile"),
});
await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
const relayPort = relay.address().port;
const origin = `http://127.0.0.1:${relayPort}`;
const selectedCase = process.env.MOBILE_VIEWPORT_E2E_CASE;
const results = [];
const configurations = [
  { width: 360, height: 800, locale: "zh-CN", colorScheme: "light" },
  { width: 390, height: 844, locale: "en-US", colorScheme: "dark" },
  { width: 430, height: 932, locale: "zh-CN", colorScheme: "dark" },
  { width: 844, height: 390, locale: "en-US", colorScheme: "light" },
];
async function record(id, engine, configuration, page, run) {
  if (selectedCase && selectedCase !== id) return;
  const label = `${id}-${engine}-${configuration.width}x${configuration.height}`;
  try {
    await run();
    await page.screenshot({ path: join(artifacts, `${label}.png`) });
    results.push({ id, engine, ...configuration, result: "passed" });
    console.log(`${label}: passed`);
  } catch (error) {
    await page.screenshot({ path: join(artifacts, `${label}-failed.png`) });
    results.push({ id, engine, ...configuration, result: "failed", error: error.message });
    throw error;
  }
}
try {
  for (const [engine, browserType] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await browserType.launch({
      ...(engine === "chromium" ? { channel: "msedge" } : {}),
      headless: true,
    });
    try {
      for (const configuration of configurations) {
        const context = await browser.newContext({
          viewport: { width: configuration.width, height: configuration.height },
          locale: configuration.locale,
          colorScheme: configuration.colorScheme,
          isMobile: true,
          hasTouch: true,
        });
        await context.addInitScript((theme) => {
          const className = theme === "dark" ? "zai-dark" : "zai-light";
          localStorage.setItem("zcode-theme", className);
          document.addEventListener("DOMContentLoaded", () =>
            document.documentElement.classList.add(className),
          );
          const viewport = Object.assign(new EventTarget(), {
            height: innerHeight,
            width: innerWidth,
            offsetTop: 0,
            offsetLeft: 0,
            scale: 1,
          });
          Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
          window.__setTestViewport = (values) => {
            Object.assign(viewport, values);
            viewport.dispatchEvent(new Event("resize"));
            viewport.dispatchEvent(new Event("scroll"));
          };
        }, configuration.colorScheme);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}/m/`);
          const input = page.getByRole("textbox").first();
          await input.waitFor();
          await record("MRV-01", engine, configuration, page, async () => {
            await input.fill("abcd1234");
            assert.equal(await input.inputValue(), "ABCD-1234");
            const state = await input.evaluate((element) => ({
              fontSize: parseFloat(getComputedStyle(element).fontSize),
              overflow: document.documentElement.scrollWidth > innerWidth,
            }));
            assert.ok(state.fontSize >= 16, `聚焦输入字号 ${state.fontSize}px 小于 16px`);
            assert.equal(state.overflow, false, "配对页不得横向溢出");
            const box = await page.getByRole("button", { name: /^(配对|Pair)$/ }).boundingBox();
            assert.ok(box && box.x >= 0 && box.x + box.width <= configuration.width + 1);
          });
          await record("MRV-02", engine, configuration, page, async () => {
            await input.focus();
            const reducedHeight = configuration.height > 500 ? 430 : 230;
            await page.evaluate(
              (height) => window.__setTestViewport({ height, offsetTop: 52 }),
              reducedHeight,
            );
            await page.waitForFunction(
              (height) =>
                Math.abs(document.getElementById("root").getBoundingClientRect().height - height) <=
                1,
              reducedHeight,
              { timeout: 2500 },
            );
            const root = await page.locator("#root").boundingBox();
            assert.ok(Math.abs(root.y - 52) <= 1, "根容器应跟随 Safari 可见视口平移");
            await page.evaluate(() => document.activeElement.blur());
            await page.evaluate(
              (height) => window.__setTestViewport({ height, offsetTop: 0 }),
              configuration.height,
            );
            await page.waitForFunction(
              (height) =>
                Math.abs(document.getElementById("root").getBoundingClientRect().height - height) <=
                1,
              configuration.height,
            );
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
              false,
            );
          });
          await record("MRV-03", engine, configuration, page, async () => {
            const before = await page.locator("#root").boundingBox();
            await page.evaluate(() =>
              window.__setTestViewport({ height: 180, offsetTop: 20, scale: 2 }),
            );
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            const after = await page.locator("#root").boundingBox();
            assert.equal(after.height, before.height, "手动缩放不能触发根布局变矮");
            await page.evaluate(
              (height) => window.__setTestViewport({ height, offsetTop: 0, scale: 1 }),
              configuration.height,
            );
          });
          if (configuration.width === 390) {
            await record("MRV-04", engine, configuration, page, async () => {
              const href = await page.locator('link[rel="manifest"]').getAttribute("href");
              const response = await context.request.get(new URL(href, page.url()).href);
              assert.match(response.headers()["content-type"], /application\/manifest\+json/);
              const manifest = await response.json();
              assert.equal(new URL(manifest.start_url, page.url()).href, `${origin}/m/`);
              assert.equal(manifest.scope, "/m/");
              assert.equal(manifest.id, "/m/");
              assert.equal(manifest.display, "standalone");
              assert.equal(manifest.icons.length, 2);
              for (const icon of manifest.icons) {
                const size = Number(icon.sizes.split("x")[0]);
                const dimensions = await page.evaluate(async (src) => {
                  const image = new Image();
                  image.src = src;
                  await image.decode();
                  return [image.naturalWidth, image.naturalHeight];
                }, new URL(icon.src, page.url()).href);
                assert.deepEqual(dimensions, [size, size]);
              }
              assert.equal(
                await page
                  .locator('meta[name="apple-mobile-web-app-capable"]')
                  .getAttribute("content"),
                "yes",
              );
              await page.waitForFunction(async () =>
                Boolean((await navigator.serviceWorker.getRegistration())?.active),
              );
              await page.reload();
              await input.waitFor();
              await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
              assert.deepEqual(await page.evaluate(() => caches.keys()), []);
              if (engine === "chromium") {
                // 安装检查必须用独立的普通 profile；隐私 context 本身禁止安装，不能当成产品故障。
                const profile = await mkdtemp(join(tmpdir(), "zcode-mobile-installability-"));
                const installContext = await chromium.launchPersistentContext(profile, {
                  channel: "msedge",
                  headless: true,
                });
                try {
                  const installPage = installContext.pages()[0];
                  await installPage.goto(`${origin}/m/`);
                  await installPage.getByRole("textbox").first().waitFor();
                  await installPage.waitForFunction(async () =>
                    Boolean((await navigator.serviceWorker.getRegistration())?.active),
                  );
                  const cdp = await installContext.newCDPSession(installPage);
                  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
                  assert.deepEqual(installabilityErrors, [], "Chromium 安装配置应合格");
                  await cdp.detach();
                } finally {
                  await installContext.close();
                  await rm(profile, { recursive: true, force: true });
                }
              }
            });
            await record("MRV-05", engine, configuration, page, async () => {
              await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
              // 断开隔离中继的真实网络，避免 WebKit 的 context 离线开关在 Worker 前拦截导航。
              relay.closeAllConnections();
              await new Promise((resolve) => relay.close(resolve));
              try {
                await page.reload();
                await page
                  .getByRole("heading", { name: "请连接网络 / Connect to the internet" })
                  .waitFor();
                assert.deepEqual(await page.evaluate(() => caches.keys()), []);
              } finally {
                await new Promise((resolve) => relay.listen(relayPort, "127.0.0.1", resolve));
              }
              await page.reload();
              await input.waitFor();
            });
          }
          assert.deepEqual(errors, [], "浏览器不得出现未处理异常");
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => relay.close(resolve));
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(
    `移动适配候选：${results.filter((result) => result.result === "passed").length}/${results.length}；产物 ${artifacts}`,
  );
}
