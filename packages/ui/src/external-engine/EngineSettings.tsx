import { useCallback, useEffect, useRef, useState } from "react";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  type ExternalEngineStatus,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import {
  useEngineConnectionProfiles,
  useExternalEngineService,
} from "@/hooks/external-engine/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Snippet, SnippetCopyButton } from "@/components/ai-elements/snippet.js";
import { ENGINE_LABELS, type EngineSettingsProps } from "./contract.js";
import { EngineConnectionProfiles } from "./EngineConnectionProfiles.js";
import { TaskClientLogo } from "./TaskClientLogo.js";
import { EngineChecks } from "./EngineChecks.js";

const ENGINES = ["claude-code", "codex"] as const;
type EngineView = {
  status?: ExternalEngineStatus;
  ready?: boolean;
  busy?: "check" | "install";
  error?: boolean;
};

export function EngineSettings({ connectivityWorkspacePath }: EngineSettingsProps = {}) {
  const service = useExternalEngineService();
  const { intl } = useZCodeIntl();
  const profiles = useEngineConnectionProfiles(service);
  const [selected, setSelected] = useState<ExternalSessionEngine>("claude-code");
  const [views, setViews] = useState<Partial<Record<ExternalSessionEngine, EngineView>>>({});
  const generations = useRef<Record<ExternalSessionEngine, number>>({
    "claude-code": 0,
    codex: 0,
  });
  const requested = useRef(new Set<ExternalSessionEngine>());
  const patch = useCallback((engine: ExternalSessionEngine, value: Partial<EngineView>) => {
    setViews((previous) => ({
      ...previous,
      [engine]: { ...previous[engine], ...value },
    }));
  }, []);
  const check = useCallback(
    async (engine: ExternalSessionEngine, fresh = false, install = false) => {
      if (!service) return;
      const generation = ++generations.current[engine];
      patch(engine, { busy: install ? "install" : "check", error: false });
      try {
        const status = await (install
          ? service.installAdapter(engine)
          : fresh && service.refreshStatus
            ? service.refreshStatus(engine)
            : service.getStatus(engine));
        if (generations.current[engine] === generation)
          patch(engine, { status, ready: status.ready, error: Boolean(status.error) });
      } catch {
        // Host 异常只显示安全提示；CLI 原始输出可能包含凭据。
        if (generations.current[engine] === generation) patch(engine, { error: true });
      } finally {
        if (generations.current[engine] === generation) patch(engine, { busy: undefined });
      }
    },
    [service, patch],
  );
  useEffect(() => {
    if (!service) return;
    let current = true;
    requested.current.clear();
    for (const engine of ENGINES) {
      const generation = generations.current[engine];
      void service.isLaunchReady?.(engine).then(
        (ready) => {
          // 快检可能晚于安装或完整诊断返回，不能覆盖新一代结果。
          if (current && generations.current[engine] === generation) patch(engine, { ready });
        },
        () => {},
      );
    }
    const subscription = service.onStatusChanged((status) => {
      if (current) patch(status.engine, { status, ready: status.ready });
    });
    return () => {
      current = false;
      for (const engine of ENGINES) generations.current[engine] += 1;
      subscription.dispose();
    };
  }, [service, patch]);
  useEffect(() => {
    if (!service || requested.current.has(selected)) return;
    requested.current.add(selected);
    void check(selected);
  }, [service, selected, check]);
  const cancel = async (engine: ExternalSessionEngine) => {
    const operation = views[engine]?.busy;
    generations.current[engine] += 1;
    patch(engine, { busy: undefined });
    try {
      await service?.invalidateStatus?.(engine, operation === "install" ? "install" : "check");
    } catch {
      patch(engine, { error: true });
    }
  };
  if (!service) return null;
  return (
    <section className="space-y-3" data-testid="agent-engine-settings">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "engine.settings.description" })}
      </p>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card md:flex-row">
        <nav
          className="flex shrink-0 gap-1 border-b border-border p-2 md:w-44 md:flex-col md:border-r md:border-b-0"
          aria-label={intl.formatMessage({ id: "engine.settings.navigation" })}
        >
          {ENGINES.map((engine) => (
            <button
              key={engine}
              type="button"
              aria-label={ENGINE_LABELS[engine]}
              aria-current={selected === engine ? "page" : undefined}
              onClick={() => setSelected(engine)}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base md:flex-none ${selected === engine ? "bg-selected" : "hover:bg-surface-hover"}`}
            >
              <TaskClientLogo engine={engine} />
              <span className="min-w-0">
                <span className="block font-medium">{ENGINE_LABELS[engine]}</span>
                <span className="block text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({
                    id:
                      views[engine]?.ready === undefined
                        ? "engine.check.notChecked"
                        : views[engine]?.ready
                          ? "engine.environmentReady"
                          : "engine.notReady",
                  })}
                </span>
              </span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {ENGINES.map((engine) => {
            const view = views[engine];
            const runtime = EXTERNAL_ENGINE_RUNTIMES[engine];
            const loginCommand = runtime.loginCommand.join(" ");
            return (
              <div
                key={engine}
                hidden={selected !== engine}
                className="space-y-4 p-4"
                data-testid={`engine-settings-${engine}`}
                aria-busy={Boolean(view?.busy)}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-ui-lg font-medium">{ENGINE_LABELS[engine]}</h3>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="outline"
                      disabled={Boolean(view?.busy)}
                      onClick={() => {
                        void check(engine, true);
                        void profiles.refresh();
                      }}
                    >
                      {intl.formatMessage({ id: "engine.refresh" })}
                    </Button>
                    {view?.busy && service.invalidateStatus ? (
                      <Button variant="ghost" onClick={() => void cancel(engine)}>
                        {intl.formatMessage({ id: "common.cancel" })}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      data-testid={`engine-install-${engine}`}
                      disabled={Boolean(view?.busy) || view?.status?.adapter.installed}
                      onClick={() => void check(engine, false, true)}
                    >
                      {intl.formatMessage({
                        id: view?.status?.adapter.installed ? "engine.installed" : "engine.install",
                      })}
                    </Button>
                  </div>
                </div>
                {view?.error ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {intl.formatMessage({ id: "engine.check.failed" })}
                  </p>
                ) : null}
                {service.getConnectionProfiles ? (
                  <EngineConnectionProfiles
                    engine={engine}
                    service={service}
                    status={view?.status}
                    connections={profiles.connections}
                    loading={profiles.loading}
                    failed={profiles.failed}
                    update={profiles.update}
                    connectivityWorkspacePath={connectivityWorkspacePath}
                    onInstall={() => void check(engine, false, true)}
                    onRefresh={() => void check(engine, true)}
                    operationBusy={Boolean(view?.busy)}
                  />
                ) : (
                  <EngineChecks
                    status={view?.status}
                    onAction={(action) =>
                      void check(engine, action !== "install", action === "install")
                    }
                  />
                )}
                <details className="text-ui-sm text-foreground-subtle">
                  <summary className="w-fit cursor-pointer rounded-md">
                    {intl.formatMessage({ id: "engine.technicalDetails" })}
                  </summary>
                  <code className="mt-2 block select-all break-all font-mono">
                    {runtime.adapterPackage}@{runtime.adapterVersion}
                  </code>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span>{intl.formatMessage({ id: "engine.login" })}</span>
                    <Snippet code={loginCommand} className="w-fit max-w-full gap-1 pl-2">
                      <code className="min-w-0 select-all break-words font-mono text-ui-sm">
                        {loginCommand}
                      </code>
                      <SnippetCopyButton
                        aria-label={intl.formatMessage(
                          { id: "engine.copyLoginCommand" },
                          { engine: ENGINE_LABELS[engine] },
                        )}
                        onError={() => patch(engine, { error: true })}
                      />
                    </Snippet>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
