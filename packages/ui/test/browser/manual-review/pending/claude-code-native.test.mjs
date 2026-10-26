import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

// spec：docs/desktop/claude-code-native-terminal-spec.md；仅验证隔离 UI 与终端契约。
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/claude-code-native.fixture.tsx";
const artifacts = join(tmpdir(), "ycode-claude-code-native");
let server;
let browser;
let origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "claude-native-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
  browser.on("page", (page) => page.setDefaultTimeout(15000));
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const [width, height, theme, locale] of [
  [1280, 800, "light", "en-US"],
  [1280, 800, "dark", "zh-CN"],
  [375, 812, "dark", "zh-CN"],
  [844, 390, "light", "en-US"],
]) {
  test(`CC01/06：入口、输入与保活 ${width}x${height}/${theme}/${locale}`, async () => {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const calls = () => page.getByTestId("calls").textContent().then(JSON.parse);
    try {
      await page.goto(
        `${origin}fixture?theme=${theme}&locale=${locale}${width < 900 ? "&mobile=1" : ""}`,
        { waitUntil: "networkidle" },
      );
      const launcher = page.locator('[data-side-pane-open-tab-item="claude-code"]');
      await launcher.waitFor();
      await page.screenshot({ path: join(artifacts, `launcher-${width}-${theme}.png`) });
      await launcher.click();
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="calls"]').textContent).creates.length ===
          1,
      );
      let state = await calls();
      assert.equal(state.creates[0].program, "claude-code");
      assert.equal(state.creates[0].cwd, "/workspace/native claude");
      const input = page.locator(".xterm-helper-textarea");
      await input.focus();
      await page.keyboard.type("hello");
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="calls"]').textContent).writes.length > 0,
      );
      await page.getByTestId("detach").click();
      assert.equal((await calls()).disposed.length, 0);
      await page.getByTestId("detach").click();
      await input.waitFor({ state: "attached" });
      await input.focus();
      await page.keyboard.type("again");
      state = await calls();
      assert.equal(state.creates.length, 1);
      assert.match(state.writes.map((item) => item.data).join(""), /helloagain/);
      await page.getByTestId("command-claude").click();
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="calls"]').textContent).creates.length ===
          2,
      );
      state = await calls();
      assert.ok(state.creates.every((item) => item.program === "claude-code"));
      await page.screenshot({ path: join(artifacts, `terminal-${width}-${theme}.png`) });
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    } finally {
      await page.close();
    }
  });
}

test("CC05：旧远端忽略 program 时释放普通 shell 并显示错误", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  try {
    await page.goto(`${origin}fixture?oldHost=1&locale=zh-CN`, { waitUntil: "networkidle" });
    await page.getByTestId("command-claude").click();
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector('[data-testid="calls"]').textContent).disposed.length ===
        1,
    );
    const state = JSON.parse(await page.getByTestId("calls").textContent());
    assert.deepEqual(state.disposed, ["1"]);
    await page
      .getByRole("alert")
      .filter({ hasText: "目标主机的终端服务尚不支持 Claude Code" })
      .waitFor();
    assert.equal(state.writes.length, 0);
    await page.getByTestId("detach").click();
    await page.getByTestId("detach").click();
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector('[data-testid="calls"]').textContent).disposed.length ===
        2,
    );
    await page.getByRole("alert").waitFor();
    const retried = JSON.parse(await page.getByTestId("calls").textContent());
    assert.equal(retried.creates.length, 2);
    assert.deepEqual(retried.disposed, ["1", "2"]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
