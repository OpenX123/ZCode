import { memo, useSyncExternalStore } from "react";
import { Moon, Settings, Sun } from "lucide-react";
import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { DesktopUpdateButton } from "@/desktop-updates/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveTheme, type Theme } from "@/useTheme.js";

function subscribeSystemTheme(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

function noSystemThemeSubscription() {
  return () => {};
}

export const WorkspaceSidebarFooter = memo(
  function WorkspaceSidebarFooterComponent({
    theme,
    onThemeChange,
    onSettingsButtonClick,
    isDesktop = false,
    isWindowsDesktop = false,
    className,
  }: {
    theme: Theme;
    onThemeChange: (value: string) => void;
    onSettingsButtonClick?: () => void;
    isDesktop?: boolean;
    /** 应用外壳注入的平台信息；更新提示按平台说明安装方式。 */
    isWindowsDesktop?: boolean;
    className?: string;
  }) {
    const { intl } = useZCodeIntl();
    // System 偏好变化不会修改 store.theme；此订阅只更新按钮展示，主题偏好仍由既有 store 持有。
    const resolvedTheme = useSyncExternalStore(
      theme === "system" ? subscribeSystemTheme : noSystemThemeSubscription,
      () => resolveTheme(theme),
      () => (theme === "system" ? "dark" : resolveTheme(theme)),
    );
    const switchesToLight = resolvedTheme === "dark";
    const targetLabel = intl.formatMessage({
      id: switchesToLight
        ? "sidebar.settings.switchToLight"
        : "sidebar.settings.switchToDark",
    });
    const settingsButtonLabel = intl.formatMessage({ id: "settings.title" });

    return (
      <footer
        className={cn(
          "flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4",
          className,
        )}
      >
        {isDesktop ? (
          <DesktopUpdateButton isWindowsDesktop={isWindowsDesktop} />
        ) : null}
        <div className="flex min-w-0 gap-2">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="min-w-0 flex-1 justify-start gap-2 overflow-hidden px-0"
            data-testid={TID_TASK_SETTINGS_BUTTON}
            aria-label={settingsButtonLabel}
            disabled={!onSettingsButtonClick}
            onClick={onSettingsButtonClick}
          >
            <Settings className="size-5" />
            <span className="truncate">{settingsButtonLabel}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            data-testid="sidebar-theme-shortcut"
            aria-label={targetLabel}
            title={targetLabel}
            onClick={() =>
              onThemeChange(
                resolveTheme(theme) === "dark" ? "zai-light" : "zai-dark",
              )
            }
          >
            {switchesToLight ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
        </div>
      </footer>
    );
  },
);
