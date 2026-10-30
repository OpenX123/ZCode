// 真实 Timeline 的流式历史隔离与搜索修订回归；不依赖真实模型。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-stream-isolation.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/conversation-stream-isolation");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "timeline-fixture",
        enforce: "pre",
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
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
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

for (const mobile of [false, true])
  for (const theme of ["light", "dark"]) {
    test(
      `流式历史隔离 ${mobile ? "compact" : "desktop"}/${theme}`,
      { timeout: 90000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 900 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          // 统计真实 ConversationTurnGroup 的 commit，不把 props 引用当作渲染性能证据。
          await page.addInitScript(() => {
            window.__turnRenders = {};
            window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
              supportsFiber: true,
              inject: () => 1,
              onCommitFiberUnmount() {},
              onPostCommitFiberRoot() {},
              onCommitFiberRoot(_id, root) {
                const walk = (fiber) => {
                  if (!fiber) return;
                  if (fiber.flags & 1 && fiber.type?.name === "ConversationTurnGroupImpl") {
                    const id = fiber.memoizedProps.unit.turnId;
                    window.__turnRenders[id] = (window.__turnRenders[id] ?? 0) + 1;
                  }
                  walk(fiber.child);
                  walk(fiber.sibling);
                };
                walk(root.current);
              },
            };
          });
          await page.goto(`${origin}fixture?mobile=${mobile}&theme=${theme}`);
          await page.locator('section[data-turn-id="history-0"]').waitFor();
          const settle = () =>
            page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
          await settle();
          const before = await page.evaluate(() => window.__turnRenders);
          assert.ok(before["history-0"] > 0 && before.active > 0, "必须观察到真实轮次渲染");
          for (let i = 0; i < 5; i++) {
            await page.getByTestId("token").click();
            await settle();
          }
          const after = await page.evaluate(() => window.__turnRenders);
          assert.equal(after["history-0"], before["history-0"], "token 不重渲染第一历史轮");
          assert.equal(after["history-1"], before["history-1"], "token 不重渲染第二历史轮");
          assert.ok(after.active >= before.active + 5, "尾轮每次 token 都渲染");
          await page.getByTestId("find").fill("needle");
          await page.waitForFunction(
            () => document.querySelector('[data-testid="matches"]').textContent === "2",
          );
          await page.getByTestId("revise").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="matches"]').textContent === "1",
          );
          await page.screenshot({
            path: join(artifacts, `${mobile ? "compact" : "desktop"}-${theme}.png`),
          });
          await writeFile(
            join(artifacts, `${mobile ? "compact" : "desktop"}-${theme}.json`),
            JSON.stringify({ before, after, matchesAfterRevision: 1 }, null, 2),
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
  }
