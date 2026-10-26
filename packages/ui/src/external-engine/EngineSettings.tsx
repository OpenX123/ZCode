import { useCallback, useEffect, useState } from "react";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  type ExternalEngineStatus,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import { useExternalEngineService } from "@/hooks/external-engine/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Snippet, SnippetCopyButton } from "@/components/ai-elements/snippet.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { ENGINE_LABELS } from "./contract.js";

export function EngineSettings() {
  const service = useExternalEngineService();
  const { intl } = useZCodeIntl();
  const [statuses, setStatuses] = useState<ExternalEngineStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!service) return;
    setBusy(true);
    setError(null);
    try {
      setStatuses(await service.listStatuses());
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [service]);
  useEffect(() => {
    if (!service) return;
    let current = true;
    setBusy(true);
    void service.listStatuses().then(
      (value) => {
        if (current) {
          setStatuses(value);
          setBusy(false);
        }
      },
      (error) => {
        if (current) {
          setError(String(error));
          setBusy(false);
        }
      },
    );
    const subscription = service.onStatusChanged((status) => {
      setStatuses((previous) => [
        ...previous.filter((value) => value.engine !== status.engine),
        status,
      ]);
    });
    return () => {
      current = false;
      subscription.dispose();
    };
  }, [service]);
  const install = async (engine: ExternalSessionEngine) => {
    if (!service) return;
    setBusy(true);
    setError(null);
    try {
      const status = await service.installAdapter(engine);
      setStatuses((previous) => [...previous.filter((value) => value.engine !== engine), status]);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!service) return null;
  return (
    <section className="space-y-4" data-testid="agent-engine-settings" aria-busy={busy}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "engine.settings.description" })}
        </p>
        <SettingsResourceHeaderActions
          onRefresh={() => void refresh()}
          refreshing={busy}
          refreshLabel={intl.formatMessage({ id: "engine.refresh" })}
        />
      </div>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SettingsGroupCard>
        {(["claude-code", "codex"] as const).map((engine) => {
          const status = statuses.find((value) => value.engine === engine);
          const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
          const loginCommand = runtime.loginCommand.join(" ");
          const copyLabel = intl.formatMessage(
            { id: "engine.copyLoginCommand" },
            { engine: ENGINE_LABELS[engine] },
          );
          return (
            <div
              key={engine}
              className="space-y-3 border-t border-border px-4 py-4 first:border-t-0"
              data-testid={`engine-settings-${engine}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-ui-base font-medium">{ENGINE_LABELS[engine]}</h3>
                    <span className="text-ui-sm text-foreground-subtle" role="status">
                      {intl.formatMessage({
                        id:
                          !status && busy
                            ? "common.loading"
                            : status?.ready
                              ? "engine.ready"
                              : "engine.notReady",
                      })}
                    </span>
                  </div>
                  {status ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
                      <span>
                        {intl.formatMessage({
                          id: status.officialCli.found ? "engine.cliFound" : "engine.cliMissing",
                        })}
                        {status.officialCli.version ? ` · ${status.officialCli.version}` : ""}
                      </span>
                      <span>
                        {intl.formatMessage({ id: `engine.auth.${status.auth.state}` })}
                        {status.auth.label ? ` · ${status.auth.label}` : ""}
                      </span>
                    </div>
                  ) : null}
                </div>
                <Button
                  size="default"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy || status?.adapter.installed}
                  onClick={() => void install(engine)}
                  data-testid={`engine-install-${engine}`}
                >
                  {intl.formatMessage({
                    id: status?.adapter.installed ? "engine.installed" : "engine.install",
                  })}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-ui-sm">
                <span className="text-foreground-subtle">
                  {intl.formatMessage({ id: "engine.login" })}
                </span>
                <Snippet code={loginCommand} className="w-fit max-w-full gap-1 pl-2">
                  <code className="min-w-0 select-all break-words font-mono text-ui-sm">
                    {loginCommand}
                  </code>
                  <SnippetCopyButton
                    aria-label={copyLabel}
                    title={copyLabel}
                    onError={(error) => setError(String(error))}
                  />
                </Snippet>
              </div>
              <details className="text-ui-sm text-foreground-subtle">
                <summary className="w-fit cursor-pointer rounded-md">
                  {intl.formatMessage({ id: "engine.technicalDetails" })}
                </summary>
                <code className="mt-2 block select-all break-all font-mono">
                  {runtime.adapterPackage}@{runtime.adapterVersion}
                </code>
              </details>
              {status?.error ? (
                <p role="alert" className="break-words text-ui-sm text-destructive">
                  {status.error}
                </p>
              ) : null}
            </div>
          );
        })}
      </SettingsGroupCard>
    </section>
  );
}
