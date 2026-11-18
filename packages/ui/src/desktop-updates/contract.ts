import type { UpdateStatePayload } from "@zcode/shared";

/** Main 是更新状态唯一所有者；UI 只决定当前状态对应的用户动作。 */
export function getDesktopUpdateAction(
  state: UpdateStatePayload | null,
): "check" | "download" | "install" | "open-release" | null {
  if (!state?.enabled) return null;
  switch (state.kind) {
    case "update-available":
      // 当前平台不在发布矩阵内时没有可自动安装的安装器，只能打开 Release 页面。
      return state.manualDownload ? (state.releaseUrl ? "open-release" : null) : "download";
    case "update-downloaded":
      return "install";
    case "error":
      return state.version ? "download" : "check";
    default:
      return null;
  }
}

/**
 * 关闭（跳过该版本）只用于发现新版和已知版本的下载失败；用户开始下载后，
 * 进度与安装包就绪状态必须持续可见，不受隐藏偏好影响。
 */
export function isDesktopUpdateDismissible(state: UpdateStatePayload | null): boolean {
  if (!state?.enabled) return false;
  return state.kind === "update-available" || (state.kind === "error" && Boolean(state.version));
}

export function getDesktopUpdateProgress(state: UpdateStatePayload | null): number {
  if (state?.kind !== "download-progress") return 0;
  const value = Number.parseFloat(state.progress);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
