import { join } from "node:path";
import { access } from "node:fs/promises";
import type { StdioStream } from "@zcode/server/remote/backend.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

// 远端数据根随 YCode 改名迁移到 ~/.ycode（docs/desktop/ycode-data-dir-migration.md）；
// 每次部署/探测前先执行 buildRemoteDataDirMigrationScript，保证该路径可用且只有一份数据。
export const REMOTE_BASE = "~/.ycode/server";

/**
 * 远端 ~/.zcode → ~/.ycode 迁移脚本（POSIX sh，单行，输出丢弃，永不失败）：
 * 1. 旧目录为真实目录且新位置为空：停止旧 Source Server（若已安装）→ mv → 在旧位置建 symlink；
 *    建链接失败则 mv 回滚。
 * 2. 仍只有旧目录（mv 失败等）：建立反向链接 ~/.ycode → ~/.zcode，新路径可用且不产生第二份数据。
 * 新 daemon 由后续 ensureDaemon 在 ~/.ycode/server 启动；POSIX rename 不受打开文件影响。
 */
export function buildRemoteDataDirMigrationScript(): string {
  const legacy = '"$HOME/.zcode"';
  const next = '"$HOME/.ycode"';
  const legacyBin = '"$HOME/.zcode/server/bin/zcode"';
  const steps = [
    `if [ -d ${legacy} ] && [ ! -L ${legacy} ] && [ ! -e ${next} ] && [ ! -L ${next} ]; then`,
    `if [ -x ${legacyBin} ]; then ${legacyBin} stop --server-root "$HOME/.zcode/server" || true; fi;`,
    `if command mv ${legacy} ${next}; then command ln -s ${next} ${legacy} || command mv ${next} ${legacy}; fi;`,
    "fi;",
    `if [ -d ${legacy} ] && [ ! -L ${legacy} ] && [ ! -e ${next} ] && [ ! -L ${next} ]; then command ln -s ${legacy} ${next}; fi`,
  ];
  return `{ ${steps.join(" ")}; } >/dev/null 2>&1 || true`;
}

export interface RemoteAssetDeployOptions {
  /** 取消当前连接初始化；共享 cache 仍可独立完成，但不得继续写入远端 staging。 */
  signal?: AbortSignal;
  releaseDir?: string | null;
  resolveReleaseDir?: (
    componentIds?: string[],
    options?: { forceRefresh?: boolean },
  ) => Promise<string | null>;
  resolveComponentSha256?: (componentId: string) => Promise<string | null>;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export interface DeployLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

export async function fileExists(...pathParts: string[]): Promise<boolean> {
  const fullPath = join(...pathParts);
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function formatOptionalValue(value?: string): string {
  return value && value.trim().length > 0 ? value : "<empty>";
}

export function formatOptionalValues(values?: string[]): string {
  const normalizedValues = values?.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalizedValues && normalizedValues.length > 0 ? normalizedValues.join(", ") : "<empty>";
}

export function buildRemoteMoveCommand(sourcePath: string, targetPath: string): string {
  // 部分远端 shell 会把 mv 定义成 alias/function（例如 mv -i）。
  // 部署通过非交互 SSH exec 执行时，覆盖确认没人输入会卡死；这里用 command 绕过 alias/function，
  // 同时加 -f 明确强制覆盖，保证临时文件替换不会等待交互确认。
  return `command mv -f ${quotePosixPathArg(sourcePath)} ${quotePosixPathArg(targetPath)}`;
}

export function buildRemoteChmodExecutableCommand(filePath: string): string {
  // 和 mv 一样，chmod 也可能被远端 shell 自定义；用 command 确保调用真实命令。
  return `command chmod +x ${quotePosixPathArg(filePath)}`;
}

export function buildRemoteExecutableReplaceCommand(
  sourcePath: string,
  targetPath: string,
): string {
  return `${buildRemoteChmodExecutableCommand(sourcePath)} && ${buildRemoteMoveCommand(sourcePath, targetPath)}`;
}

export function createRemoteAssetPlaceholderError(
  platformArch: string,
  options: RemoteAssetDeployOptions,
  resourceLabel: string,
): Error {
  // 远端部署资源在生产态需要走 CDN + 本地缓存。
  // 如果这里仍然只报“本地文件缺失”，排障时会误判成打包漏文件；
  // 统一把错误指向配置（CDN 基址/缓存目录）和缓存内容，避免定位方向跑偏。
  return new Error(
    `[deploy] ${resourceLabel} missing for ${platformArch}. ` +
      `Development should read from mock-cdn/releases; production should download and cache remote assets from CDN ` +
      `(remoteCdnBaseUrl=${formatOptionalValue(options.remoteCdnBaseUrl)}, remoteCdnBaseUrls=${formatOptionalValues(options.remoteCdnBaseUrls)}, remoteCacheDir=${formatOptionalValue(options.remoteCacheDir)}).`,
  );
}

export function waitForClose(stream: StdioStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrText = "";
    stream.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrText.length >= 2048) {
        return;
      }
      stderrText += chunk.toString();
    });

    stream.onClose((code) => {
      // 之前只等待 close 不校验退出码，远端命令失败会被当成成功继续执行。
      // 这会导致部署链路把失败写成“已完成”（甚至继续写 version），形成假成功状态。
      if (code !== 0) {
        const stderrSummary = stderrText.trim();
        reject(
          new Error(
            stderrSummary.length > 0
              ? `[deploy] remote command failed with exit code ${code}: ${stderrSummary}`
              : `[deploy] remote command failed with exit code ${code}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
