import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Menu } from "electron";

const run = promisify(execFile);
type NativeCapture = {
  menu?: Menu;
  openedExact: boolean;
  openCount: number;
  requestCount: number;
  restore(): void;
};
type CaptureGlobal = typeof globalThis & { __cacheRecoveryNative?: NativeCapture };

/** 合成容器密码仅走 stdin；参数、输出和错误均不携带密码。 */
export async function setSyntheticCacheRecoveryPassword(password: string) {
  const container = process.env.ZCODE_E2E_SSH_CONTAINER;
  const username = process.env.ZCODE_E2E_SSH_USERNAME;
  if (
    !container?.startsWith("zcode-task16-ssh-") ||
    username !== "zcodee2e" ||
    /[\r\n:]/u.test(password)
  ) {
    throw new Error("密码碰撞 fixture 不属于已批准的合成 SSH 环境");
  }
  const child = spawn("docker", ["exec", "-i", "--user", "0", container, "chpasswd"], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", () => reject(new Error("合成密码 fixture 无法启动")));
    child.once("exit", (code) =>
      code === 0 ? resolveExit() : reject(new Error("合成密码 fixture 失败")),
    );
    child.stdin.end(`${username}:${password}\n`);
  });
}

/** 保留真实 openPath、原生托盘 Menu 和确认对话框，只输出目标匹配与实际选择。 */
export async function installCacheRecoveryNativeObservers(
  aParent: string,
  confirmationFile: string,
) {
  const expectedPathHash = createHash("sha256")
    .update(resolve(aParent).toLowerCase())
    .digest("hex");
  await browser.electron.execute(
    (electron, expectedHash, resultFile) => {
      const originalOpen = electron.shell.openPath;
      const originalMenu = electron.Tray.prototype.setContextMenu;
      const originalDialog = electron.dialog.showMessageBoxSync;
      const target = globalThis as CaptureGlobal;
      const capture: NativeCapture = {
        openedExact: false,
        openCount: 0,
        requestCount: 0,
        restore() {
          electron.shell.openPath = originalOpen;
          electron.Tray.prototype.setContextMenu = originalMenu;
          electron.dialog.showMessageBoxSync = originalDialog;
          delete target.__cacheRecoveryNative;
        },
      };
      target.__cacheRecoveryNative = capture;
      electron.shell.openPath = async (path) => {
        const crypto = process.getBuiltinModule("node:crypto");
        const pathModule = process.getBuiltinModule("node:path");
        capture.openCount += 1;
        capture.openedExact =
          crypto
            .createHash("sha256")
            .update(pathModule.resolve(path).toLowerCase())
            .digest("hex") === expectedHash;
        return originalOpen(path);
      };
      electron.Tray.prototype.setContextMenu = function (menu) {
        capture.menu = menu ?? undefined;
        return originalMenu.call(this, menu);
      };
      electron.dialog.showMessageBoxSync = ((...args: Parameters<typeof originalDialog>) => {
        const result = Reflect.apply(originalDialog, electron.dialog, args) as number;
        process
          .getBuiltinModule("node:fs")
          .appendFileSync(
            resultFile,
            JSON.stringify({ result, nativeDialogReturned: true }) + "\n",
          );
        return result;
      }) as typeof originalDialog;
    },
    expectedPathHash,
    confirmationFile,
  );
  for (const locale of ["en-US", "zh-CN"] as const) {
    await browser.execute(async (value) => {
      await (
        window as unknown as { zcode: { setApplicationLocale(locale: string): Promise<void> } }
      ).zcode.setApplicationLocale(value);
    }, locale);
  }
}

export async function readCacheRecoveryNativeOpen() {
  return browser.electron.execute(() => {
    const capture = (globalThis as CaptureGlobal).__cacheRecoveryNative;
    return { openedExact: capture?.openedExact ?? false, openCount: capture?.openCount ?? 0 };
  });
}

/** 调用实际原生 MenuItem handler；不是物理托盘点击，也不直接 app.quit。 */
export async function requestCacheRecoveryProductQuit() {
  await browser.electron.execute((electron) => {
    const capture = (globalThis as CaptureGlobal).__cacheRecoveryNative;
    const item = capture?.menu?.items.find((entry) => ["退出", "Quit"].includes(entry.label));
    const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!capture || !item || !window) throw new Error("实际托盘退出 MenuItem 不存在");
    capture.requestCount += 1;
    // 先结束 CDP 请求再进入同步原生确认，外部 Computer Use 才能处理真实取消/退出。
    setTimeout(() => item.click(item, window, {}), 0);
  });
}

/** 系统 Explorer 的 Folder.Self.Path 只与精确 A 比较，不枚举或归档用户其它路径。 */
export async function explorerShowsExactCacheRecoveryFolder(aParent: string): Promise<boolean> {
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s=New-Object -ComObject Shell.Application; $match=$false; foreach($w in @($s.Windows())) { try { if([IO.Path]::GetFileName($w.FullName) -ieq 'explorer.exe' -and $w.Document.Folder.Self.Path -ieq $env:TASK16_EXPECTED_FOLDER) {$match=$true} } catch {} }; if($match){'true'}else{'false'}",
    ],
    { env: { ...process.env, TASK16_EXPECTED_FOLDER: aParent }, windowsHide: true },
  );
  return result.stdout.trim() === "true";
}
