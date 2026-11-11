import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";
import { PluginUiBackgroundHost, PluginUiFollowUpDialogHost } from "@/plugin-ui/index.js";

export function RootShell({ children }: { children: ReactNode }) {
  // 修复依据：手机入口已经按软键盘后的可见视口确定高度，子外壳重算 dvh 会再次溢出。
  return (
    <div className="relative h-full">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
      <PluginUiFollowUpDialogHost />
      <PluginUiBackgroundHost />
    </div>
  );
}
