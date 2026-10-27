import type { UpdateStatePayload } from "@zcode/shared";

/** Main 是更新状态唯一所有者；UI 只决定当前状态对应的用户动作。 */
export function getDesktopUpdateAction(
  state: UpdateStatePayload | null,
): "check" | "download" | "install" | null {
  if (!state?.enabled) return null;
  switch (state.kind) {
    case "update-available":
      return "download";
    case "update-downloaded":
      return "install";
    case "error":
      return state.version ? "download" : "check";
    default:
      return null;
  }
}

export function getDesktopUpdateProgress(state: UpdateStatePayload | null): number {
  if (state?.kind !== "download-progress") return 0;
  const value = Number.parseFloat(state.progress);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
