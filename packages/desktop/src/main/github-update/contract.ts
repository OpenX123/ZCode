import type { UpdateCheckResultPayload, UpdateStatePayload } from "@zcode/shared";

/** Main 唯一 owner；调用方只投影快照，不缓存第二份更新事实。 */
export interface GithubDesktopUpdateContract {
  /** 同步快照不发起请求。 */
  getState(): UpdateStatePayload;
  /** 自动检查受六小时节流，手动检查绕过节流；并发请求合并。 */
  checkForUpdates(manual?: boolean): Promise<UpdateCheckResultPayload>;
  /** 用户明确操作后下载并打开；并发合并且不退出应用。 */
  downloadUpdate(): Promise<UpdateCheckResultPayload>;
  /** 重新校验并打开已下载安装器。 */
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
  /** 与 Electron shell.openPath 一致：空字符串表示打开成功。 */
  openInstaller(path: string): Promise<string>;
  now?: () => number;
}
