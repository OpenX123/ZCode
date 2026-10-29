import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/markdown-diagram.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/markdown-diagram-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "markdown-diagram-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
    server: { host: "127.0.0.1", port: 0, hmr: false },
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

function assertOrthogonalPaths(paths, direction = "TD") {
  assert.ok(paths.length > 0);
  const ends = [];
  for (const path of paths) {
    assert.ok(!/[CASTHV]/i.test(path), `连线包含非正交指令：${path}`);
    let previous;
    const points = [];
    for (const [, command, values] of path.matchAll(/([MLQ])([^MLQ]+)/g)) {
      const coordinates = values
        .trim()
        .split(/[,\s]+/)
        .map(Number);
      const end = coordinates.slice(-2);
      if (command === "L") {
        assert.ok(
          Math.abs(end[0] - previous[0]) < 0.01 || Math.abs(end[1] - previous[1]) < 0.01,
          `连线包含斜线：${path}`,
        );
      } else if (command === "Q") {
        const control = coordinates.slice(0, 2);
        const horizontalThenVertical =
          Math.abs(control[1] - previous[1]) < 0.01 && Math.abs(control[0] - end[0]) < 0.01;
        const verticalThenHorizontal =
          Math.abs(control[0] - previous[0]) < 0.01 && Math.abs(control[1] - end[1]) < 0.01;
        assert.ok(
          horizontalThenVertical || verticalThenHorizontal,
          `转角不与正交主干相切：${path}`,
        );
        assert.ok(
          Math.hypot(end[0] - previous[0], end[1] - previous[1]) <= 15,
          `圆角过大：${path}`,
        );
      }
      points.push(end);
      previous = end;
    }
    assert.ok(points.length > 1);
    ends.push(points);
  }
  const first = ends[0];
  const end = first.at(-1);
  const before = first.findLast((point) => Math.hypot(point[0] - end[0], point[1] - end[1]) > 0.01);
  assert.ok(before);
  assert.ok(Math.abs(end[direction === "LR" ? 1 : 0] - before[direction === "LR" ? 1 : 0]) < 0.01);
}

for (const [width, height] of [
  [375, 844],
  [844, 390],
  [1100, 1000],
]) {
  for (const theme of ["zai-light", "zai-dark"]) {
    test(`MMD05/MMD06 完整图表与操作 ${width}/${theme}`, async () => {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: width === 375,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.goto(`${origin}fixture?theme=${theme}`);
        const diagram = page.locator("[data-mermaid-block]");
        await diagram.locator('[role="img"] > svg').waitFor();
        assertOrthogonalPaths(
          await diagram
            .locator(".flowchart-link")
            .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("d"))),
        );
        const geometry = await diagram.evaluate((el) => {
          const svg = el.querySelector("svg").getBoundingClientRect();
          const box = el.getBoundingClientRect();
          const clipped = [...el.querySelectorAll("div"), el].some((node) => {
            const style = getComputedStyle(node);
            return (
              ["auto", "scroll", "hidden"].includes(style.overflowY) &&
              node.scrollHeight > node.clientHeight + 1
            );
          });
          return {
            fits: svg.top >= box.top - 1 && svg.bottom <= box.bottom + 1,
            clipped,
            height: svg.height,
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.equal(geometry.clipped, false);
        assert.equal(geometry.fits, true);
        assert.equal(geometry.pageOverflow, false);
        if (width === 1100) assert.ok(geometry.height > 420);
        await diagram.getByText("工作台读取本地数据", { exact: true }).waitFor();
        await page.getByRole("heading", { name: "多门店数据同步方案" }).waitFor();
        assert.equal(await page.locator("main table tbody tr").count(), 2);
        assert.equal(await page.locator("main blockquote").count(), 1);
        const code = page.locator('[data-language="typescript"]');
        assert.ok(await code.getByText("typescript", { exact: true }).isVisible());
        assert.ok(await code.getByRole("button", { name: "自动换行" }).isVisible());
        const block = page.locator('[data-language="mermaid"]');
        if (width !== 375) await block.hover();
        const preview = block.getByRole("button", { name: "放大查看" });
        if (width === 375) {
          const touchTarget = await preview.boundingBox();
          assert.ok(touchTarget.width >= 44 && touchTarget.height >= 44);
        }
        await preview.focus();
        assert.equal(
          await preview.evaluate((el) => {
            const toolbar = el.closest(".mermaid-toolbar");
            return toolbar ? Number(getComputedStyle(toolbar).opacity) : 0;
          }),
          1,
        );
        await preview.press("Enter");
        await page.getByRole("dialog").waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "dialog");
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        if (width === 375) await block.getByRole("button", { name: "放大查看" }).tap();
        else await diagram.dblclick();
        await page.getByRole("dialog").waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "dialog");
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await block.getByRole("button", { name: "复制代码" }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(copied.startsWith("flowchart TD\n"));
        assert.ok(copied.endsWith("H[工作台读取本地数据]"));
        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
        assert.deepEqual(errors, []);
      } catch (error) {
        await page.screenshot({
          path: join(artifacts, `failed-${width}-${theme}.png`),
          fullPage: true,
        });
        throw error;
      } finally {
        await context.close();
      }
    });
  }
}

test("MMD05 横向流程图保持直角折线", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}fixture?theme=zai-light&direction=LR`);
    const svg = page.locator('[data-mermaid-block] [role="img"] > svg');
    await svg.waitFor();
    assertOrthogonalPaths(
      await svg
        .locator(".flowchart-link")
        .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("d"))),
      "LR",
    );
  } finally {
    await page.close();
  }
});

test("MMD05 紧凑布局节省空间，源码可显式恢复布局与曲线", async () => {
  const page = await browser.newPage();
  try {
    const bounds = async (query) => {
      await page.goto(`${origin}fixture?theme=zai-light${query}`);
      const svg = page.locator('[data-mermaid-block] [role="img"] > svg');
      await svg.waitFor();
      return svg.evaluate((el) => ({
        height: el.viewBox.baseVal.height,
        font: getComputedStyle(el.querySelector(".nodeLabel")).fontSize,
        paths: [...el.querySelectorAll(".flowchart-link")].map((edge) => edge.getAttribute("d")),
      }));
    };
    const compact = await bounds("");
    const spacious = await bounds("&spacious=1");
    assert.ok(compact.height < spacious.height);
    assert.equal(compact.font, spacious.font);
    assert.ok(spacious.paths.some((path) => /C/.test(path)));
  } finally {
    await page.close();
  }
});

for (const [width, theme] of [
  [1100, "zai-light"],
  [1100, "zai-dark"],
  [375, "zai-light"],
]) {
  test(`MMD05 分支汇合与回边方正布局 ${width}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`${origin}fixture?theme=${theme}&complex=1`);
      const svg = page.locator('[data-mermaid-block] [role="img"] > svg');
      await svg.waitFor();
      assertOrthogonalPaths(
        await svg
          .locator(".flowchart-link")
          .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("d"))),
      );
      assert.equal(await svg.locator(".zcode-decision rect.basic").count(), 2);
      assert.equal(await svg.locator(".node polygon").count(), 0);
      const nodes = await svg.locator(".node").evaluateAll((elements) =>
        elements.map((el) => {
          const box = el.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      );
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i],
            b = nodes[j];
          assert.ok(
            a.x + a.width <= b.x + 1 ||
              b.x + b.width <= a.x + 1 ||
              a.y + a.height <= b.y + 1 ||
              b.y + b.height <= a.y + 1,
            "节点不得重叠",
          );
        }
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(artifacts, `complex-${width}-${theme}.png`),
        fullPage: true,
      });
    } finally {
      await page.close();
    }
  });
}

for (const theme of ["light", "dark", "zai-light", "zai-dark"]) {
  test(`MMD05 默认节点文字对比与字体 ${theme}`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}fixture?theme=${theme}`);
      const svg = page.locator('[data-mermaid-block] [role="img"] > svg');
      await svg.waitFor();
      const colors = await svg.evaluate((el) => {
        const node = el.querySelector(".node");
        return {
          fill: getComputedStyle(node.querySelector("rect")).fill,
          text: getComputedStyle(node.querySelector(".nodeLabel")).color,
          font: parseFloat(getComputedStyle(node.querySelector(".nodeLabel")).fontSize),
        };
      });
      const luminance = (color) =>
        color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((value) => value / 255)
          .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const values = [luminance(colors.fill), luminance(colors.text)].sort((a, b) => b - a);
      assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, JSON.stringify(colors));
      await page.getByRole("button", { name: "切换字体" }).click();
      await page.waitForFunction((before) => {
        const label = document.querySelector("[data-mermaid-block] .nodeLabel");
        return label && parseFloat(getComputedStyle(label).fontSize) > before;
      }, colors.font);
    } finally {
      await page.close();
    }
  });
}

test("MMD05 作者显式样式保持优先", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}fixture?theme=zai-light&styled=1`);
    const rect = page.locator('[data-mermaid-block] [role="img"] .node.custom rect.basic');
    await rect.waitFor();
    assert.deepEqual(
      await rect.evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.fill, style.stroke, style.rx];
      }),
      ["rgb(255, 241, 242)", "rgb(190, 18, 60)", "0px"],
    );
    assert.equal(await page.locator("[data-mermaid-block] .node.custom polygon").count(), 1);
  } finally {
    await page.close();
  }
});

test("MMD05 其他图种、子图与特殊节点继续正常渲染", async () => {
  const page = await browser.newPage();
  try {
    for (const diagram of ["sequence", "state", "subgraph"]) {
      await page.goto(`${origin}fixture?theme=zai-light&diagram=${diagram}`);
      await page.locator('[data-mermaid-block] [role="img"] > svg').waitFor();
      assert.equal(await page.locator('[data-mermaid-block] [role="alert"]').count(), 0);
      if (diagram === "subgraph") {
        assert.equal(await page.locator("[data-mermaid-block] .cluster").count(), 1);
        assert.equal((await page.locator("[data-mermaid-block] .node path").count()) > 0, true);
      }
    }
  } finally {
    await page.close();
  }
});

test("MMD01/MMD02/MMD06 流式保图、缓存首屏与减少动态效果", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(`${origin}fixture?theme=zai-light&streaming=1`);
    const image = page.locator("[data-mermaid-block] [role=img]");
    await image.locator("svg").waitFor();
    assert.equal(await image.evaluate((el) => getComputedStyle(el).transform), "none");
    const svg = await image.innerHTML();
    await page.getByRole("button", { name: "切换流式" }).click();
    assert.equal(await image.innerHTML(), svg);
    assert.equal(await page.locator("[data-mermaid-block] [role=alert]").count(), 0);
    await page.getByRole("button", { name: "切换流式" }).click();
    await page.getByRole("button", { name: "切换挂载" }).click();
    await page.getByRole("button", { name: "切换挂载" }).click();
    await image.waitFor();
    assert.equal(await image.getAttribute("data-mermaid-reveal"), null);
    assert.equal(await page.locator("[data-mermaid-block] [role=status]").count(), 0);
    assert.equal(await image.evaluate((el) => el.getAnimations().length), 0);
  } finally {
    await page.close();
  }
});
