import { Play } from "lucide-react";
import type {
  TaskNotificationPreferences,
  TaskNotificationSoundCategory,
  TaskNotificationSoundId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { previewTaskNotificationSound } from "@/lib/taskNotificationSound.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  TASK_NOTIFICATION_SOUND_OPTIONS,
  type TaskNotificationPreferencesPatch,
} from "./contract.js";

const SOUND_FIELD: Record<TaskNotificationSoundCategory, "completedSound" | "attentionSound"> = {
  completed: "completedSound",
  attention: "attentionSound",
};

function SoundRow({
  category,
  preferences,
  onChange,
}: {
  category: TaskNotificationSoundCategory;
  preferences: TaskNotificationPreferences;
  onChange: (patch: TaskNotificationPreferencesPatch) => void;
}) {
  const { intl } = useZCodeIntl();
  const field = SOUND_FIELD[category];
  const value = preferences[field];
  const label = intl.formatMessage({ id: `settings.notificationSounds.${category}` });
  return (
    <SettingsRow
      label={label}
      description={intl.formatMessage({
        id: `settings.notificationSounds.${category}Description`,
      })}
      control={
        <>
          <Select
            value={value}
            disabled={!preferences.enabled}
            onValueChange={(next) => onChange({ [field]: next as TaskNotificationSoundId })}
          >
            <SelectTrigger
              data-testid={`notification-sound-select-${category}`}
              aria-label={label}
              className="min-w-0 flex-1 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_NOTIFICATION_SOUND_OPTIONS.map((soundId) => (
                <SelectItem key={soundId} value={soundId}>
                  {intl.formatMessage({ id: `settings.notificationSounds.option.${soundId}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            data-testid={`notification-sound-preview-${category}`}
            aria-label={intl.formatMessage(
              { id: "settings.notificationSounds.preview" },
              { label },
            )}
            disabled={value === "mute"}
            onClick={() => void previewTaskNotificationSound(value)}
          >
            <Play />
          </Button>
        </>
      }
    />
  );
}

/**
 * 任务通知设置行：总开关、两类提示音（含试听）与前台播放开关。
 * 纯展示组件，偏好读写由调用方经 useTaskNotificationPreferences 注入。
 */
export function TaskNotificationSettings({
  preferences,
  onChange,
}: {
  preferences: TaskNotificationPreferences;
  onChange: (patch: TaskNotificationPreferencesPatch) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.notification" })}
        description={intl.formatMessage({ id: "settings.notificationDescription" })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.notification" })}
            checked={preferences.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
        }
      />
      <SoundRow category="completed" preferences={preferences} onChange={onChange} />
      <SoundRow category="attention" preferences={preferences} onChange={onChange} />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.notificationSounds.playWhenFocused" })}
        description={intl.formatMessage({
          id: "settings.notificationSounds.playWhenFocusedDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.notificationSounds.playWhenFocused" })}
            checked={preferences.playWhenFocused}
            disabled={!preferences.enabled}
            onCheckedChange={(playWhenFocused) => onChange({ playWhenFocused })}
          />
        }
      />
    </>
  );
}
