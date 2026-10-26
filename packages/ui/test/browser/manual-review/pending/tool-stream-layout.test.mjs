import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/tool-stream-layout.fixture.tsx";
const artifacts = join(tmpdir(), "tool-stream-layout");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "tool-stream-layout-fixture",
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
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

// 真实 V4 工具流：长名称、终端失败、审核行混排，增量更新不能改变旧行几何位置。
for (const width of [375, 966])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`工具流间距 ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 896 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          const summaries = page.locator('[data-testid^="tool-summary-trigger-stream-"]');
          await summaries.nth(5).waitFor();
          const measure = () =>
            summaries.evaluateAll((nodes) =>
              nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return { top: rect.top, height: rect.height, left: rect.left, right: rect.right };
              }),
            );
          const positions = (items) =>
            items.map(({ top, height, left }) => ({ top, height, left }));
          const before = await measure();
          const shortLabelsFit = await summaries.evaluateAll((nodes) =>
            nodes.every((node, index) => {
              if (index % 4 === 0) return true;
              const label = node.querySelector(".tool-summary-kind-label");
              return label && label.scrollWidth <= label.clientWidth;
            }),
          );
          assert.equal(shortLabelsFit, true, "短工具类别应完整显示");
          for (let i = 0; i < before.length; i++) {
            assert.equal(before[i].height, 24, "摘要应为单行，状态不能撑高");
            assert.ok(before[i].left >= 0 && before[i].right <= width, "摘要不可横向溢出");
            if (i > 0) assert.equal(before[i].top - before[i - 1].top - before[i - 1].height, 12);
          }
          await page.getByRole("button", { name: "追加工具", exact: true }).click();
          await summaries.nth(7).waitFor();
          assert.deepEqual(
            positions((await measure()).slice(0, 6)),
            positions(before),
            "追加工具和状态更新不能移动已有摘要",
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          const first = summaries.first();
          await first.focus();
          await page.keyboard.press("Enter");
          assert.equal(await first.getAttribute("aria-expanded"), "true");
          const detail = page
            .getByTestId("chat-tool-call-block-stream-0")
            .locator('[data-slot="collapsible-content"]');
          await detail.waitFor({ state: "visible" });
          // 展开后保留完整原始命令，而非只留下摘要中可见的截断片段。
          assert.match(await detail.innerText(), /official-plugins/);
          await page.keyboard.press("Enter");
          await detail.waitFor({ state: "hidden" });
          assert.deepEqual(
            positions((await measure()).slice(0, 6)),
            positions(before),
            "收起详情后恢复原有间距",
          );
          assert.deepEqual(errors, []);
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}.png`),
            fullPage: true,
          });
        } finally {
          await page.close();
        }
      });
    }

test("横屏与放大字号、减少动态效果", async () => {
  const page = await browser.newPage({
    viewport: { width: 812, height: 375 },
    reducedMotion: "reduce",
  });
  try {
    await page.goto(`${origin}fixture?theme=dark&locale=zh-CN`);
    await page.getByTestId("tool-summary-trigger-stream-5").waitFor();
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-size", "28px"));
    const summaries = page.locator('[data-testid^="tool-summary-trigger-stream-"]');
    for (const row of await summaries.all()) {
      const box = await row.boundingBox();
      assert.ok(box.height <= 48, "放大字号后仍保持单行摘要");
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: join(artifacts, "landscape-large-text.png"), fullPage: true });
  } finally {
    await page.close();
  }
});
