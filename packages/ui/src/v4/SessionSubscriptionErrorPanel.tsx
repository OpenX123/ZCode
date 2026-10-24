import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
}

export function SessionSubscriptionErrorPanel({
  error,
  sessionId,
  workspacePath,
  onReconnect,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p className="max-w-full break-words text-center font-mono text-destructive">{error}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
