import { AlertTriangle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function UsageStatsErrorNotice({ error }: { error: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div role="alert" className="flex min-w-0 items-start gap-1.5 text-ui-base text-destructive">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {intl.formatMessage({ id: "settings.usage.appUsageLoadFailed" })}: {error}
      </span>
    </div>
  );
}
