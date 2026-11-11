import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TID_PREVIEW_PANE, TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared/test-ids";
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
    await waitForDefaultWorkspaceReady();
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
            text: document.body.innerText,
            panes: Array.from(document.querySelectorAll("[data-file-manager-pane]")).map(
              (pane) => ({
                html: pane.innerHTML.slice(0, 15000),
                rect: pane.getBoundingClientRect().toJSON(),
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
});

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
async function waitVisible(filename: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id, name) => {
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
          if (name.endsWith(".md"))
            return Boolean(
              pane
                .querySelector("[data-markdown-preview]")
                ?.textContent?.includes("YD_MARKDOWN_VISIBLE"),
            );
          return Array.from(pane.querySelectorAll("diffs-container")).some((node) =>
            node.shadowRoot?.textContent?.includes("YD_PYTHON_VISIBLE"),
          );
        },
        TID_PREVIEW_PANE,
        filename,
      ),
    { timeout: 15000, timeoutMsg: `预览正文没有实际可见 ${filename}` },
  );
}
