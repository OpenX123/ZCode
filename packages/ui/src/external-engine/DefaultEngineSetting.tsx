import { useState } from "react";
import {
  SESSION_ENGINES,
  sessionEngineSchema,
  resolveSessionEngine,
  type SessionEngine,
} from "@zcode/shared/external-engine";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { toast } from "@/components/ui/toast.js";
import { ENGINE_LABELS } from "./contract.js";

export function DefaultEngineSetting() {
  const services = useBaseWorkspaceServices();
  const { settings, loading, update } = useSettings({ services });
  const { intl } = useZCodeIntl();
  const [saving, setSaving] = useState(false);
  const selectEngine = async (engine: SessionEngine) => {
    setSaving(true);
    try {
      await update({ defaultSessionEngine: engine });
    } catch {
      toast(intl.formatMessage({ id: "engine.preferenceSaveFailed" }), { variant: "warning" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "engine.default.title" })}
        description={intl.formatMessage({ id: "engine.default.description" })}
        control={
          <Select
            value={resolveSessionEngine({ engine: settings?.defaultSessionEngine })}
            onValueChange={(value) => void selectEngine(sessionEngineSchema.parse(value))}
            disabled={loading || saving}
          >
            <SelectTrigger
              className="text-ui-sm"
              aria-label={intl.formatMessage({ id: "engine.default.title" })}
              data-testid="default-session-engine-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_ENGINES.map((engine) => (
                <SelectItem key={engine} value={engine}>
                  {ENGINE_LABELS[engine]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}
