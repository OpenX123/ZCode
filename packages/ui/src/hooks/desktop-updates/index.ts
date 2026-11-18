import { useCallback, useSyncExternalStore } from "react";
import type { IPlatformService, UpdateCheckResultPayload } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { getDesktopUpdateAction, isDesktopUpdateDismissible } from "@/desktop-updates/contract.js";
import { createDesktopUpdateProjection } from "./projection.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

const projections = new WeakMap<
  IPlatformService,
  ReturnType<typeof createDesktopUpdateProjection>
>();
const emptySnapshot = () => null;
const emptySubscribe = () => () => {};

export function useDesktopUpdates(isDesktop = true) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const localServices = useBaseWorkspaceServices();
  const { settings, update } = useSettings({ services: localServices });
  let projection = projections.get(platform);
  if (!projection) {
    projection = createDesktopUpdateProjection(platform);
    projections.set(platform, projection);
  }
  const supported = isDesktop && !!platform.checkForUpdates && !!platform.onUpdateState;
  const state = useSyncExternalStore(
    supported ? projection.subscribe : emptySubscribe,
    supported ? projection.getSnapshot : emptySnapshot,
    emptySnapshot,
  );
  const run = useCallback(
    async (action: "check" | "download" | "install") => {
      if (!supported) return;
      let result: UpdateCheckResultPayload;
      try {
        const method =
          action === "check"
            ? platform.checkForUpdates
            : action === "download"
              ? platform.downloadUpdate
              : platform.installUpdate;
        if (!method) return;
        result = await method.call(platform);
      } catch (error) {
        result = { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
      if (
        ["available", "ready", "downloading", "already-downloading", "manual-download"].includes(
          result.kind,
        )
      ) {
        // 手动操作必须给出可执行反馈，不能因上次关闭侧栏而静默吞掉发现结果。
        if (settings?.dismissedDesktopUpdateVersion) {
          try {
            await update({ dismissedDesktopUpdateVersion: null });
          } catch {
            toast(intl.formatMessage({ id: "desktopUpdate.preferenceSaveFailed" }), {
              variant: "warning",
            });
          }
        }
        if (result.kind === "available" || result.kind === "ready") {
          toast(intl.formatMessage({ id: "desktopUpdate.found" }, { version: result.version }), {
            variant: "info",
            dedupeKey: "desktop-update",
          });
        }
        if (result.kind === "manual-download") {
          // 当前平台不在发布矩阵内：不是失败，提示并提供打开 Release 页面的动作。
          const { releaseUrl } = result;
          toast(
            intl.formatMessage(
              { id: "desktopUpdate.manualDownloadFound" },
              { version: result.version },
            ),
            {
              variant: "info",
              dedupeKey: "desktop-update",
              actionLabel: intl.formatMessage({ id: "desktopUpdate.openRelease" }),
              onAction: () => platform.openExternal(releaseUrl),
            },
          );
        }
      }
      if (
        result.kind === "up-to-date" ||
        result.kind === "dev-skipped" ||
        result.kind === "error"
      ) {
        toast(
          intl.formatMessage(
            { id: `desktopUpdate.${result.kind}` },
            result.kind === "error"
              ? { message: result.message }
              : result.kind === "up-to-date"
                ? { version: result.currentVersion }
                : {},
          ),
          { variant: result.kind === "error" ? "warning" : "info", dedupeKey: "desktop-update" },
        );
      }
    },
    [supported, platform, intl, settings?.dismissedDesktopUpdateVersion, update],
  );
  const version = state && "version" in state ? state.version : undefined;
  // 原因：旧实现对所有带版本的状态套用隐藏偏好，已开始下载的进度与就绪安装包会因此消失。
  // 隐藏只作用于“发现新版”和已知版本的下载失败，下载中与已就绪状态始终展示。
  const dismissible = isDesktopUpdateDismissible(state);
  return {
    state,
    supported,
    busy: state?.kind === "checking" || state?.kind === "download-progress",
    dismissible,
    dismissed: Boolean(
      dismissible && version && settings?.dismissedDesktopUpdateVersion === version,
    ),
    dismiss: async () => {
      if (!dismissible || !version) return;
      try {
        await update({ dismissedDesktopUpdateVersion: version });
      } catch {
        toast(intl.formatMessage({ id: "desktopUpdate.preferenceSaveFailed" }), {
          variant: "warning",
        });
      }
    },
    check: () => run("check"),
    activate: () => {
      const action = getDesktopUpdateAction(state);
      if (action === "open-release") {
        // 发布矩阵外的平台只打开 Main 提供的 releaseUrl，不调用下载命令。
        if (state?.releaseUrl) platform.openExternal(state.releaseUrl);
        return Promise.resolve();
      }
      return action ? run(action) : Promise.resolve();
    },
  };
}
