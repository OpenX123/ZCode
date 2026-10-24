import { documentViewerInstance } from "@/plugin-ui/contract.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { type ReactNode } from "react";
import { PuzzleIcon, type LucideIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import {
  usePluginUiSurfaces,
  resolvePluginUiSurfaceTitle,
} from "@/plugin-ui/adapters/usePluginUiSurfaces.js";

export interface PluginUiLauncherItemsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 正式会话 id；草稿态为 null，此时不显示入口（面板是会话级，第一版不支持草稿）。 */
  sessionId: string | null;
  onOpenPluginUi: (request: OpenPluginUiSideTabRequest) => void;
  /** 菜单复用标准菜单项；空白页与内置应用共用 SidePaneLauncherRow。 */
  variant?: "launcher" | "menu";
}

export function buildPluginUiLauncherItemId(pluginId: string, surfaceId: string): string {
  return `plugin-ui:${pluginId}/${surfaceId}`;
}

/**
 * "打开标签页"里的插件面板入口，与内建项共用列表/网格。
 * 旧分组容器会占据一个网格单元，导致插件全部挤在同一列；使用 Fragment 让按钮直接参与父级布局。
 */
export function PluginUiLauncherItems(props: PluginUiLauncherItemsProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const surfaces = usePluginUiSurfaces({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
    enabled: props.sessionId !== null,
  });
  if (!props.sessionId || surfaces.length === 0) return null;
  const parentSessionId = props.sessionId;
  return surfaces.map((surface) => {
    const title = resolvePluginUiSurfaceTitle(surface.title, locale);
    const itemId = buildPluginUiLauncherItemId(surface.pluginId, surface.id);
    const open = () => {
      if (
        !platform?.pluginSandbox ||
        props.remoteSessionId ||
        isRemoteWorkspaceIdentity(props.workspaceIdentity ?? "")
      ) {
        toast(intl.formatMessage({ id: "settings.plugins.store.ui.unsupported" }));
        return;
      }
      props.onOpenPluginUi({
        parentSessionId,
        surfaceId: surface.id,
        serverName: surface.server,
        pluginId: surface.pluginId,
        resourceUri: surface.resourceUri,
        ...documentViewerInstance(surface.resourceUri),
        title,
        workspacePath: props.workspacePath,
        ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
        remoteSessionId: props.remoteSessionId ?? null,
      });
    };
    return props.variant === "menu" ? (
      <DropdownMenuItem key={itemId} data-side-pane-add-item={itemId} onSelect={open}>
        <PuzzleIcon className="size-4 text-foreground-subtle" />
        {title}
      </DropdownMenuItem>
    ) : (
      <SidePaneLauncherRow
        key={itemId}
        itemId={itemId}
        icon={PuzzleIcon}
        label={title}
        onOpen={open}
      />
    );
  });
}

/**
 * 「打开标签页」条目：内置应用与 UI 插件共用的横向行（对齐原型 SidePaneAppLauncher）。
 * 整行是一个按钮，尾部「打开」只做视觉胶囊，避免按钮嵌套按钮。
 */
export function SidePaneLauncherRow({
  itemId,
  icon: Icon,
  avatar,
  label,
  description,
  actionLabel,
  loading,
  disabled,
  onOpen,
}: {
  itemId: string;
  icon: LucideIcon;
  avatar?: ReactNode;
  label: string;
  description?: string;
  actionLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      data-side-pane-open-tab-item={itemId}
      className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={onOpen}
      disabled={disabled}
      aria-busy={loading || undefined}
    >
      {/* 应用插件复用市场图标来源；固定 PuzzleIcon 会忽略已发布的品牌图片。 */}
      {avatar ?? (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface">
          <Icon className="size-6 text-foreground-subtle" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-semibold text-foreground">{label}</span>
        {description ? (
          <span
            className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
            title={description}
          >
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          buttonVariants({ variant: "secondary", size: "sm" }),
          "shrink-0 rounded-full",
        )}
      >
        {loading ? (
          <Spinner
            data-testid="side-pane-plugin-progress"
            className="size-3.5 motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
        {actionLabel ?? intl.formatMessage({ id: "settings.plugins.store.ui.open" })}
      </span>
    </button>
  );
}
