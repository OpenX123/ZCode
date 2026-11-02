import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// 旧版仅打开 DMG，用户仍需手动退出和拖拽。助手在 Main 真正退出后才替换，避免覆盖运行中的包。
// 所有路径均通过位置参数传入，不能把安装目录拼进 shell 源码。
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
set -eu
target="$1"
staged="$2"
old_pid="$3"
work="$4"
log="$5"
opener="$6"
remaining="$7"
backup="$work/previous.app"
moved=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$moved" = 1 ]; then
    echo '安装失败，恢复旧版'
    if [ -e "$target" ]; then /bin/mv "$target" "$work/failed.app" || exit 1; fi
    /bin/mv "$backup" "$target" || exit 1
    "$opener" -n "$target" || true
  fi
  /bin/rm -rf "$work"
  exit "$result"
}
trap cleanup EXIT
exec 3>&1
exec >> "$log" 2>&1
printf 'READY\\n' >&3
exec 3>&-
while kill -0 "$old_pid" 2>/dev/null; do
  if [ "$remaining" -le 0 ]; then echo '等待旧版退出超时，未替换'; exit 1; fi
  remaining=$((remaining - 1))
  /bin/sleep 1
done
/bin/mv "$target" "$backup"
moved=1
/bin/mv "$staged" "$target"
"$opener" -n "$target"
moved=0
echo '已替换并启动新版'
`;

export interface MacInstallOptions {
  appPath: string;
  version: string;
  installerPath: string;
  logPath: string;
  signal: AbortSignal;
  confirmInstall(): boolean;
  quitForInstall(): Promise<void>;
}

async function plistValue(appPath: string, key: string): Promise<string> {
  const { stdout } = await exec("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appPath, "Contents", "Info.plist"),
  ]);
  return stdout.trim();
}

/** 先完成同卷准备；失败或取消不进入不可逆的退出屏障。 */
export async function installMacUpdate(options: MacInstallOptions): Promise<boolean> {
  const appPath = await realpath(options.appPath);
  if (
    !appPath.endsWith(".app") ||
    appPath.startsWith("/Volumes/") ||
    appPath.includes("/AppTranslocation/")
  ) {
    throw new Error("请先将 YCode 移至应用程序目录，再安装更新");
  }
  await access(dirname(appPath), constants.W_OK);
  await access(appPath, constants.W_OK);
  const bundleId = await plistValue(appPath, "CFBundleIdentifier");
  const work = await mkdtemp(join(dirname(appPath), ".ycode-update-"));
  await chmod(work, 0o700);
  const mountPath = join(work, "volume");
  const staged = join(work, basename(appPath));
  let handedOff = false;
  let mounted = false;
  let helper: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(mountPath);
    options.signal.throwIfAborted();
    await exec("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPath,
      options.installerPath,
    ]);
    mounted = true;
    const apps = (await readdir(mountPath)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("更新镜像须包含唯一应用");
    const source = join(mountPath, apps[0]!);
    if (
      (await plistValue(source, "CFBundleIdentifier")) !== bundleId ||
      (await plistValue(source, "CFBundleShortVersionString")) !== options.version
    ) {
      throw new Error("更新应用的身份或版本与清单不匹配");
    }
    await exec("/usr/bin/ditto", ["--noqtn", source, staged]);
    const executable = await plistValue(staged, "CFBundleExecutable");
    if (!executable || basename(executable) !== executable) throw new Error("更新应用入口无效");
    await access(join(staged, "Contents", "MacOS", executable), constants.X_OK);
    await exec("/usr/bin/hdiutil", ["detach", mountPath]);
    mounted = false;
    options.signal.throwIfAborted();
    if (!options.confirmInstall()) return false;
    const script = join(work, "install.sh");
    await writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o700 });
    await mkdir(dirname(options.logPath), { recursive: true });
    // 在退出屏障前确认助手已运行；Main 退出时不能依赖其自身继续执行文件替换。
    helper = spawn(
      "/bin/sh",
      [script, appPath, staged, String(process.pid), work, options.logPath, "/usr/bin/open", "120"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const onExit = () => reject(new Error("更新安装助手未能启动"));
      helper!.once("error", reject);
      helper!.once("exit", onExit);
      helper!.stdout!.once("data", () => {
        helper!.removeListener("exit", onExit);
        resolve();
      });
    });
    options.signal.throwIfAborted();
    helper.stdout?.destroy();
    helper.unref();
    await options.quitForInstall();
    handedOff = true;
    return true;
  } finally {
    if (!handedOff) {
      if (helper) {
        const stopped = new Promise<void>((resolve) => {
          if (!helper!.pid || helper!.exitCode !== null || helper!.signalCode !== null) resolve();
          else helper!.once("close", () => resolve());
        });
        helper.kill();
        await stopped;
      }
      if (mounted) {
        await exec("/usr/bin/hdiutil", ["detach", mountPath])
          .then(() => {
            mounted = false;
          })
          .catch(() => {});
      }
      // 卸载失败时保留挂载点，不能递归删除仍挂载的镜像内容。
      if (!mounted) await rm(work, { recursive: true, force: true });
    }
  }
}
