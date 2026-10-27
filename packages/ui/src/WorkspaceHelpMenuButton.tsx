import { useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import {
  TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
  TID_WORKSPACE_HELP_MENU_TRIGGER,
} from "@zcode/shared/test-ids";
import { ActivityIcon, CircleHelpIcon, DownloadIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useDesktopUpdates } from "@/hooks/desktop-updates/index.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function WorkspaceHelpMenuButton({
  className,
  isDesktop = false,
}: {
  className?: string;
  /**
   * 是否桌面端。由挂载处注入而不是在组件内嗅探：Web 的 IPlatformService 桩同样实现了
   * executeDesktopCommand（no-op），拿它判定会让 Web 端出现一个点了没反应的「资源管理器」。
   */
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const updates = useDesktopUpdates(isDesktop);
  const [open, setOpen] = useState(false);
  const helpMenuLabel = intl.formatMessage({ id: "workspaceHeader.help.menu" });
  const handleOpenResourceManager = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager);
  };

  const handleShowAbout = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ControlHintTooltip title={helpMenuLabel} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            // Settings 页会把帮助按钮绝对定位在 Electron 顶部拖拽区上方。
            // 只依赖外层容器 no-drag 时，真实 trigger 仍可能被标题栏 drag 区吞掉点击。
            className={cn(
              "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
              className,
            )}
            aria-label={helpMenuLabel}
            data-testid={TID_WORKSPACE_HELP_MENU_TRIGGER}
          >
            <CircleHelpIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-0 w-max [&_[data-slot=dropdown-menu-item]]:pr-6"
      >
        {/* Windows/Linux 没有原生菜单栏，自绘标题栏箭头菜单也已下线，
            资源管理器只能从这里进；Web 端没有该窗口，不渲染。 */}
        {isDesktop ? (
          <>
            <DropdownMenuSeparator />
            {updates.supported ? (
              <DropdownMenuItem
                data-testid="workspace-help-menu-check-updates"
                disabled={updates.busy}
                onSelect={() => void updates.check()}
              >
                <RefreshCwIcon className="size-4" />
                {intl.formatMessage({ id: "desktopUpdate.check" })}
              </DropdownMenuItem>
            ) : null}
            {/* 独立导出入口曾被移除；复用原菜单动作，保持打包、系统定位与提示一致。 */}
            <DropdownMenuItem onSelect={() => void runExportLogsAction(platform, intl)}>
              <DownloadIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.exportLogs" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER}
              onSelect={handleOpenResourceManager}
            >
              <ActivityIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleShowAbout}>
              <InfoIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.about" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
