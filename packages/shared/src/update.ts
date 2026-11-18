import type { ElectronReleaseChannel, Locale } from "./protocol.js";

export interface PostUpdateReleaseNotesPayload {
  version: string;
  title: string;
  markdown: string;
  releaseDate?: string;
  releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
}

/**
 * 用户从菜单手动点击"检查更新"后，main 进程回传给 renderer 的结果。
 * Renderer 根据 kind 展示对应的 toast；不要与启动时的自动 check 混用。
 */
export type UpdateCheckResultPayload =
  | { kind: "up-to-date"; currentVersion: string }
  | {
      kind: "available";
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | { kind: "downloading"; version: string }
  | { kind: "already-downloading"; version: string; progress: string }
  | { kind: "ready"; version: string }
  | { kind: "dev-skipped" }
  /** 新版已发布，但当前平台不在发布矩阵内，只能从 Release 页面手动下载。 */
  | { kind: "manual-download"; version: string; releaseUrl: string }
  | { kind: "error"; message: string };

/**
 * 桌面 GitHub 更新的持续状态；Main 唯一管理，所有窗口仅投影快照。
 */
export type UpdateStatePayload = {
  /** 当前实际运行版本；由 Main 提供，Renderer 不比较版本决定更新。 */
  currentVersion?: string;
  releaseUrl?: string;
} & (
  | { kind: "idle"; enabled: boolean }
  | { kind: "checking"; enabled: boolean }
  | {
      kind: "update-available";
      enabled: boolean;
      version: string;
      /** 当前平台没有自动安装器；UI 只打开 releaseUrl，不发起下载。 */
      manualDownload?: boolean;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "download-progress";
      enabled: boolean;
      progress: string;
      transferredBytes?: number;
      totalBytes?: number;
      version?: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "update-downloaded";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | { kind: "error"; enabled: boolean; message: string; version?: string }
);
