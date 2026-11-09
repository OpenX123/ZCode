import type {
  ExternalEngineCheck,
  ExternalEngineConnectionView,
  ExternalEngineStatus,
} from "@zcode/shared/external-engine";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { engineAuthSummary } from "./connectionProfileLabels.js";

type Action = ExternalEngineCheck["actions"][number];

export function EngineChecks({
  status,
  profile,
  onAction,
  busy,
  testAvailable = true,
}: {
  status?: ExternalEngineStatus;
  profile?: ExternalEngineConnectionView;
  onAction: (action: Action) => void;
  busy?: boolean;
  testAvailable?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // 缺少 profileId 的旧诊断不能推断属于当前连接，避免把默认身份套给其他连接。
  const matched = Boolean(profile && status?.connectionProfileId === profile.id);
  const fallback: ExternalEngineCheck[] = status
    ? [
        {
          id: "cli",
          state: status.officialCli.found ? "passed" : "failed",
          source: "path",
          actions: status.officialCli.found ? [] : ["refresh"],
          version: status.officialCli.version,
        },
        {
          id: "adapter",
          state: status.adapter.installed ? "passed" : "failed",
          source: "managed",
          actions: status.adapter.installed ? [] : ["install"],
          version: status.adapter.version,
        },
        ...(matched
          ? [
              {
                id: "authentication" as const,
                state:
                  // 旧 Host 的 CLI 登录状态也可能仅表示本地有 Key，不能据此显示远端认证通过。
                  profile?.mode === "apiKey" ||
                  status.auth.label === "apiKey" ||
                  status.auth.state === "unknown"
                    ? ("unknown" as const)
                    : status.auth.state === "loggedIn"
                      ? ("passed" as const)
                      : ("failed" as const),
                source:
                  profile?.mode === "apiKey" ? ("credentialStore" as const) : ("cli" as const),
                connectionProfileId: profile?.id,
                actions: ["test" as const],
              },
              {
                id: "route" as const,
                state: "unknown" as const,
                source: profile?.mode === "inherit" ? ("cli" as const) : ("profile" as const),
                connectionProfileId: profile?.id,
                gatewayHost: status.auth.gatewayHost,
                actions: ["test" as const],
              },
            ]
          : []),
      ]
    : [];
  const checks = (status?.checks ?? fallback).filter(
    (check) =>
      check.id === "cli" ||
      check.id === "adapter" ||
      (matched && check.connectionProfileId === profile?.id),
  );
  return (
    <div className="space-y-2" data-testid="engine-checks">
      <h4 className="text-ui-base font-medium">
        {intl.formatMessage({ id: "engine.check.title" })}
      </h4>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.check.description" })}
      </p>
      {!status ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "engine.check.notChecked" })}
        </p>
      ) : null}
      {checks.map((check) => (
        <details
          key={`${check.id}-${check.connectionProfileId ?? "environment"}-${check.state}`}
          open={check.state !== "passed"}
          className="rounded-lg border border-border px-3 py-2"
          data-testid={`engine-check-${check.id}`}
        >
          <summary className="cursor-pointer text-ui-base">
            <span className="font-medium">
              {intl.formatMessage({ id: `engine.check.${check.id}` })}
            </span>
            <span
              className={`ml-2 text-ui-sm ${check.state === "failed" ? "text-warning" : "text-foreground-subtle"}`}
            >
              {intl.formatMessage({ id: `engine.check.state.${check.state}` })}
              {check.version ? ` · ${check.version}` : ""}
            </span>
          </summary>
          <div className="mt-2 space-y-2 text-ui-sm text-foreground-subtle">
            <p>
              {intl.formatMessage(
                { id: "engine.check.source" },
                {
                  source: intl.formatMessage({
                    id: `engine.check.source.${check.source}`,
                  }),
                },
              )}
            </p>
            {check.id === "authentication" && matched && status ? (
              <p data-testid={`engine-auth-${status.engine}`}>
                {(profile?.mode === "apiKey" || status.auth.label === "apiKey") &&
                status.auth.state === "loggedIn"
                  ? intl.formatMessage({
                      id:
                        profile?.mode === "apiKey"
                          ? "engine.check.keySaved"
                          : "engine.check.cliKeyDetected",
                    })
                  : engineAuthSummary(intl, status)}
              </p>
            ) : null}
            {check.id === "route" ? (
              <p className="break-words">
                {check.gatewayHost ?? intl.formatMessage({ id: "engine.check.routeDefault" })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {check.actions
                .filter((action) => action !== "edit" || (profile && !profile.builtIn))
                .map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    disabled={busy || (action === "test" && !testAvailable)}
                    onClick={() => onAction(action)}
                  >
                    {intl.formatMessage({
                      id: `engine.check.action.${action}`,
                    })}
                  </Button>
                ))}
            </div>
          </div>
        </details>
      ))}
      {profile && !matched ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "engine.check.authNotChecked" })}
        </p>
      ) : null}
    </div>
  );
}
