import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import type { DesktopUpdatePreferences } from "./contract.js";

/**
 * 设置页“自动检查更新 / 自动下载更新”。偏好是本机 AppSettings 字段，Main 更新 owner
 * 经 syncAppSettings 即时生效；本组件只展示与发命令。
 */
export function DesktopUpdateSettings({
  preferences,
  onChange,
}: {
  preferences: DesktopUpdatePreferences;
  onChange: (patch: Partial<DesktopUpdatePreferences>) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.updates.autoCheck" })}
        description={intl.formatMessage({ id: "settings.updates.autoCheckDescription" })}
        control={
          <Switch
            data-testid="settings-update-auto-check"
            aria-label={intl.formatMessage({ id: "settings.updates.autoCheck" })}
            checked={preferences.autoCheck}
            onCheckedChange={(autoCheck) => onChange({ autoCheck })}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.updates.autoDownload" })}
        description={intl.formatMessage({ id: "settings.updates.autoDownloadDescription" })}
        control={
          <Switch
            data-testid="settings-update-auto-download"
            aria-label={intl.formatMessage({ id: "settings.updates.autoDownload" })}
            checked={preferences.autoDownload}
            onCheckedChange={(autoDownload) => onChange({ autoDownload })}
          />
        }
      />
    </>
  );
}
