import type { UpdateStatePayload } from "@zcode/shared";
import { getDesktopUpdateAction } from "./contract.js";

/** 已下载时重试安装，不再次下载。 */
export function exampleDesktopUpdatesUi(state: UpdateStatePayload) {
  return getDesktopUpdateAction(state);
}
