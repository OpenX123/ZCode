import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useDesktopUpdates } from "@/hooks/desktop-updates/index.js";
import { getDesktopUpdateAction, getDesktopUpdateProgress } from "./contract.js";

export function DesktopUpdateButton() {
  const { intl } = useZCodeIntl();
  const { state, busy, activate } = useDesktopUpdates();
  if (!state?.enabled || state.kind === "idle" || state.kind === "checking") return null;
  // 无候选版本的检查错误只通过手动检查提示，避免启动时长期占用侧栏。
  if (state.kind === "error" && !state.version) return null;
  const progress = getDesktopUpdateProgress(state);
  const message =
    state.kind === "update-available"
      ? "available"
      : state.kind === "update-downloaded"
        ? "ready"
        : state.kind === "error"
          ? "retry"
          : "downloading";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-9 w-full justify-start px-2 py-2 text-ui-sm"
        data-testid="desktop-update-action"
        disabled={busy || !getDesktopUpdateAction(state)}
        onClick={() => void activate()}
      >
        {busy ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : state.kind === "error" ? (
          <RefreshCw className="size-4" />
        ) : (
          <Download className="size-4" />
        )}
        <span className="truncate">
          {intl.formatMessage(
            { id: `desktopUpdate.${message}` },
            { version: "version" in state ? (state.version ?? "") : "", progress },
          )}
        </span>
      </Button>
      <div
        data-testid="desktop-update-status"
        role="status"
        aria-live="polite"
        className="break-words text-ui-xs text-muted-foreground"
      >
        {state.kind === "error"
          ? state.message
          : intl.formatMessage({
              id:
                state.kind === "update-downloaded"
                  ? "desktopUpdate.readyHint"
                  : "desktopUpdate.downloadHint",
            })}
      </div>
      {state.kind === "download-progress" ? (
        <div
          role="progressbar"
          aria-label={intl.formatMessage({ id: "desktopUpdate.progress" })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-1 overflow-hidden rounded bg-muted"
        >
          <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}
