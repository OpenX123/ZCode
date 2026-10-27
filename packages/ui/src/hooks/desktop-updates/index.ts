import { useCallback, useSyncExternalStore } from "react";
import type { IPlatformService, UpdateCheckResultPayload } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { getDesktopUpdateAction } from "@/desktop-updates/contract.js";
import { createDesktopUpdateProjection } from "./projection.js";

const projections = new WeakMap<
  IPlatformService,
  ReturnType<typeof createDesktopUpdateProjection>
>();
const emptySnapshot = () => null;
const emptySubscribe = () => () => {};

export function useDesktopUpdates(isDesktop = true) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
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
    [supported, platform, intl],
  );
  return {
    state,
    supported,
    busy: state?.kind === "checking" || state?.kind === "download-progress",
    check: () => run("check"),
    activate: () => {
      const action = getDesktopUpdateAction(state);
      return action ? run(action) : Promise.resolve();
    },
  };
}
