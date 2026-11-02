import type { UpdateCheckResultPayload, UpdateStatePayload } from "@zcode/shared";

/** Main 唯一 owner；调用方只投影快照，不缓存第二份更新事实。 */
export interface GithubDesktopUpdateContract {
  /** 同步快照不发起请求。 */
  getState(): UpdateStatePayload;
  /** 自动检查受六小时节流，手动检查绕过节流；并发请求合并。 */
  checkForUpdates(manual?: boolean): Promise<UpdateCheckResultPayload>;
  /** 用户明确操作后下载并交接安装；macOS 退出并替换，Windows 打开安装器。 */
  downloadUpdate(): Promise<UpdateCheckResultPayload>;
  /** 重新校验并安装已下载的更新。 */
  installUpdate(): Promise<UpdateCheckResultPayload>;
  /** 订阅同一 owner；返回注销函数。 */
  subscribe(listener: (state: UpdateStatePayload) => void): () => void;
  /** 启动自动检查与定时器，重复调用无副作用。 */
  start(): void;
  /** 取消请求和定时器，迟到响应不再发布或打开安装器。 */
  dispose(): void;
}

export interface GithubDesktopUpdateOptions {
  currentVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  cacheDir: string;
  fetch: typeof globalThis.fetch;
  /** 空字符串表示交接成功或用户取消；signal 在退出屏障前阻止迟到安装。 */
  openInstaller(path: string, version: string, signal: AbortSignal): Promise<string>;
  now?: () => number;
}
