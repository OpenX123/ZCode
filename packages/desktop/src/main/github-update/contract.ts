import type { UpdateCheckResultPayload, UpdateStatePayload } from "@zcode/shared";

/** 本机 AppSettings 的自动更新偏好运行值；缺席字段按开启。 */
export interface GithubDesktopUpdatePreferences {
  /** 启动、6 小时定时与唤醒自动检查。 */
  autoCheck: boolean;
  /** 发现新版后后台下载并校验，退出时安装。 */
  autoDownload: boolean;
}

/** 安装交接模式：restart 为用户点击“重启以更新”；quit 为应用正常退出时安装。 */
export type GithubDesktopInstallMode = "restart" | "quit";

/** Main 唯一 owner；调用方只投影快照，不缓存第二份更新事实。 */
export interface GithubDesktopUpdateContract {
  /** 同步快照不发起请求。 */
  getState(): UpdateStatePayload;
  /** 自动检查受六小时节流与 autoCheck 偏好约束，手动检查绕过两者；并发请求合并。 */
  checkForUpdates(manual?: boolean): Promise<UpdateCheckResultPayload>;
  /** 用户明确操作后下载并校验，完成后为 update-downloaded，不打开安装器。 */
  downloadUpdate(): Promise<UpdateCheckResultPayload>;
  /** “重启以更新”：重新校验已下载的更新并以 restart 模式交接安装。 */
  installUpdate(): Promise<UpdateCheckResultPayload>;
  /** 应用正常退出时调用：有已校验安装包且未交接时以 quit 模式交接；不抛错。 */
  installOnQuit(): Promise<boolean>;
  /** 合并偏好补丁并即时生效（定时器、后台下载）。 */
  setPreferences(patch: Partial<GithubDesktopUpdatePreferences>): void;
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
  openInstaller(
    path: string,
    version: string,
    signal: AbortSignal,
    mode: GithubDesktopInstallMode,
  ): Promise<string>;
  /** 初始偏好；缺省为两项均开启。 */
  preferences?: Partial<GithubDesktopUpdatePreferences>;
  now?: () => number;
}
