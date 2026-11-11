import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TID_PREVIEW_PANE,
  TID_SIDE_PANE_TOGGLE,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForDefaultWorkspaceReady,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import {
  startElectronWindowRecording,
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
} from "#e2e/helpers/electron-window-recorder";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const ROOT = join(DEFAULT_WORKSPACE, "YD_PREVIEW");
const ARTIFACTS = process.env.YCODE_DESKTOP_QA_DIR ?? join(tmpdir(), "ycode-desktop-qa");

describe("YD-PREVIEW-01 桌面窄栏文件正文", () => {
  after(async () => {
    await clearAppData();
    await rm(ROOT, { recursive: true, force: true });
  });
  it("Markdown 与 Python 在目录切换和窗口缩放后仍实际可见", async function () {
    this.timeout(150_000);
    await mkdir(ROOT, { recursive: true });
    await mkdir(ARTIFACTS, { recursive: true });
    await writeFile(join(ROOT, "readme.md"), "# YCode Markdown\n\nYD_MARKDOWN_VISIBLE\n");
    await writeFile(join(ROOT, "example.py"), 'print("YD_PYTHON_VISIBLE")\n');
    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady();
    await setCurrentElectronRendererContentSize(1440, 900);
    // 真实安装版留下了两个分栏均为零的持久布局，读取成功仍会把正文裁成零宽。
    await browser.execute(() =>
      localStorage.setItem(
        "react-resizable-panels:file-manager-layout:preview:directory",
        JSON.stringify({ preview: 0, directory: 0 }),
      ),
    );
    const targetUrl = await browser.getUrl();
    const recording = await startElectronWindowRecording({
      outputPath: join(ARTIFACTS, "preview-layout.webm"),
      captureFrame: async () =>
        Buffer.from(
          await browser.electron.execute(async (electron, url) => {
            const target = electron.BrowserWindow.getAllWindows().find(
              (win) => win.webContents.getURL() === url,
            );
            if (!target) throw new Error("Recording target missing");
            return (await target.webContents.capturePage()).toPNG().toString("base64");
          }, targetUrl),
          "base64",
        ),
    });
    try {
      for (const filename of ["readme.md", "example.py"]) {
        await openProjectFileTree(DEFAULT_WORKSPACE);
        await clickPath(ROOT);
        await clickPath(join(ROOT, filename));
        await waitVisible(filename);
        await setCurrentElectronRendererContentSize(900, 720);
        await expandSidePane();
        await waitVisible(filename);
        await browser.saveScreenshot(join(ARTIFACTS, `${filename}.png`));
        await setCurrentElectronRendererContentSize(1440, 900);
      }
    } catch (error) {
      await browser.saveScreenshot(join(ARTIFACTS, "failure.png"));
      await writeFile(
        join(ARTIFACTS, "failure-dom.json"),
        JSON.stringify(
          await browser.execute(() => ({
            viewport: [window.innerWidth, window.innerHeight],
            text: document.body.innerText,
            panes: Array.from(document.querySelectorAll("[data-file-manager-pane]")).map(
              (pane) => ({
                html: pane.innerHTML.slice(0, 15000),
                rect: pane.getBoundingClientRect().toJSON(),
                ancestors: (() => {
                  const result = [];
                  for (let node: Element | null = pane; node; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    result.push({
                      tag: node.tagName,
                      className: node.className,
                      rect: node.getBoundingClientRect().toJSON(),
                      display: style.display,
                      overflow: style.overflow,
                    });
                  }
                  return result;
                })(),
                shadow: Array.from(pane.querySelectorAll("diffs-container")).map((node) =>
                  node.shadowRoot?.innerHTML.slice(-12000),
                ),
              }),
            ),
          })),
          null,
          2,
        ),
      );
      throw error;
    } finally {
      const result = await recording.stop();
      await writeFile(
        join(ARTIFACTS, "manifest.json"),
        JSON.stringify(
          { video_capture_mode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE, ...result },
          null,
          2,
        ),
      );
    }
  });
  it("消息中的 Markdown 文件卡片打开新预览后正文实际可见", async function () {
    this.timeout(150_000);
    await setCurrentElectronRendererContentSize(1440, 900);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    const marker = "E2E_ASSISTANT_PREVIEW_CARDS_SOURCE_AND_COLD";
    await sendV4Prompt(
      `${marker}: create assistant-preview-e2e/本轮 输出/index 页面.html and assistant-preview-e2e/本轮 输出/说明 文档.md, then report both.`,
    );
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${marker}_DONE`),
      "文件链接夹具没有完成",
      90_000,
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const row = document.querySelector<HTMLElement>(
            '[data-preview-card-title="说明 文档.md"]',
          );
          const button = Array.from(row?.querySelectorAll("button") ?? []).find((item) =>
            ["预览", "Preview", "打开", "Open"].includes(item.textContent?.trim() ?? ""),
          );
          button?.click();
          return Boolean(button);
        }),
      { timeout: 15_000 },
    );
    try {
      await waitVisible("说明 文档.md", "APC05 Markdown renderer marker");
      await browser.saveScreenshot(join(ARTIFACTS, "message-markdown.png"));
    } catch (error) {
      await browser.saveScreenshot(join(ARTIFACTS, "message-markdown-failure.png"));
      throw error;
    }
  });
});

async function expandSidePane() {
  // 缩小窗口会按既有规则自动收起侧栏，需重新展开后再检查正文。
  await browser.waitUntil(
    () =>
      browser.execute((id) => {
        const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
        const label = toggle?.getAttribute("aria-label");
        if (["展开侧边面板", "Expand side pane"].includes(label ?? "")) toggle?.click();
        return ["收起侧边面板", "Collapse side pane"].includes(label ?? "");
      }, TID_SIDE_PANE_TOGGLE),
    { timeout: 15_000 },
  );
}

async function clickPath(path: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) =>
              item.dataset.testid === id &&
              item.getBoundingClientRect().width > 0 &&
              item.getBoundingClientRect().left < window.innerWidth,
          );
          row?.click();
          return Boolean(row);
        },
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout: 15000, timeoutMsg: `文件条目不可见 ${path}` },
  );
}
async function waitVisible(filename: string, expectedMarker?: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id, name, expectedMarker) => {
          const pane = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
          ).find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 160 && rect.left < window.innerWidth && rect.right > 0;
          });
          const rect = pane?.getBoundingClientRect();
          if (
            !pane ||
            !rect ||
            rect.width < 160 ||
            rect.height < 80 ||
            rect.left >= window.innerWidth ||
            rect.right <= 0 ||
            !(pane.closest<HTMLElement>("[data-file-manager-pane]") ?? pane).innerText.includes(
              name,
            )
          )
            return false;
          // 正文在 DOM 中不代表实际可见：必须检查文本自身的矩形及命中区域，防止零高或裁剪假通过。
          const marker =
            expectedMarker ?? (name.endsWith(".md") ? "YD_MARKDOWN_VISIBLE" : "YD_PYTHON_VISIBLE");
          const roots = name.endsWith(".md")
            ? [pane.querySelector("[data-markdown-preview]")]
            : Array.from(pane.querySelectorAll("diffs-container")).map((node) => node.shadowRoot);
          return roots.some((root) => {
            if (!root) return false;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              const offset = text.textContent?.indexOf(marker) ?? -1;
              if (offset < 0) continue;
              const range = document.createRange();
              range.setStart(text, offset);
              range.setEnd(text, offset + marker.length);
              const box = range.getBoundingClientRect();
              const x = box.x + Math.min(box.width / 2, 20);
              const y = box.y + box.height / 2;
              if (
                box.width <= 0 ||
                box.height <= 0 ||
                x < rect.left ||
                x >= Math.min(rect.right, window.innerWidth) ||
                y < rect.top ||
                y >= Math.min(rect.bottom, window.innerHeight)
              )
                return false;
              const hit = document.elementFromPoint(x, y);
              const host = root instanceof ShadowRoot ? root.host : text.parentElement;
              return Boolean(hit && host && (host === hit || host.contains(hit)));
            }
            return false;
          });
        },
        TID_PREVIEW_PANE,
        filename,
        expectedMarker,
      ),
    { timeout: 15000, timeoutMsg: `预览正文没有实际可见 ${filename}` },
  );
}
