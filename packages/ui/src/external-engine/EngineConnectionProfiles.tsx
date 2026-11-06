import { useState, type FormEvent } from "react";
import {
  ANTHROPIC_OFFICIAL_BASE_URL,
  CODEX_OFFICIAL_BASE_URL,
  ENGINE_CONNECTION_NAME_MAX_LENGTH,
  type ExternalEngineConnectionCommand,
  type ExternalEngineConnectionTestResult,
  type ExternalEngineConnectionUpdate,
  type ExternalEngineConnectionView,
  type ExternalEngineConnectionsView,
  type ExternalEngineStatus,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import type { ExternalEngineServiceHandle } from "@/hooks/external-engine/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { ErrorDiagnostics } from "@/components/ai-elements/error-diagnostics.js";
import { ENGINE_LABELS } from "./contract.js";
import {
  engineConnectionModeLabel,
  engineConnectionProfileName,
  engineConnectionRouteLabel,
  visibleEngineConnectionProfiles,
} from "./connectionProfileLabels.js";

type ManagedMode = "official" | "apiKey";
interface FormState {
  /** 编辑时的原配置；保存会生成新 ID 并隐藏原配置。 */
  profileId?: string;
  name: string;
  mode: ManagedMode;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasKey: boolean;
}
type TestState =
  | { profileId: string; running: true }
  | { profileId: string; running: false; result: ExternalEngineConnectionTestResult };

const officialBaseUrl = (engine: ExternalSessionEngine) =>
  engine === "codex" ? CODEX_OFFICIAL_BASE_URL : ANTHROPIC_OFFICIAL_BASE_URL;

// 只把受控错误码映射为操作提示，不回显可能包含认证数据的原始异常。
const FAILURE_IDS: Array<[string, string]> = [
  ["connection_url_invalid", "engine.connection.invalidUrl"],
  ["api_key_missing", "engine.connection.missingKey"],
  ["engine_not_ready", "engine.connection.engineMissing"],
  ["process_interrupted", "engine.connection.interrupted"],
  ["login_failed", "engine.connection.loginFailed"],
  ["login_running", "engine.connection.loginRunning"],
  ["connections_unreadable", "engine.connection.unreadable"],
  ["connection_test_running", "engine.profile.testRunning"],
  ["connection_test_unavailable", "engine.profile.testNeedsWorkspace"],
];

export interface EngineConnectionProfilesProps {
  engine: ExternalSessionEngine;
  service: ExternalEngineServiceHandle;
  status?: ExternalEngineStatus;
  connections: ExternalEngineConnectionsView | null;
  loading: boolean;
  /** 读取连接配置失败（如文件损坏或无权限）；保留界面并提示，不回落到另一身份。 */
  failed?: boolean;
  update: (command: ExternalEngineConnectionCommand) => Promise<ExternalEngineConnectionUpdate>;
  /** 承载连接测试的本地 workspace；缺省时测试不可用。 */
  connectivityWorkspacePath?: string;
}

export function EngineConnectionProfiles({
  engine,
  service,
  status,
  connections,
  loading,
  failed,
  update,
  connectivityWorkspacePath,
}: EngineConnectionProfilesProps) {
  const { intl } = useZCodeIntl();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);
  const profiles = visibleEngineConnectionProfiles(connections, engine);
  const defaultId = connections?.defaults[engine];
  const engineLabel = ENGINE_LABELS[engine];
  const workspacePath = connectivityWorkspacePath?.trim();
  const failure = (reason: unknown) => {
    const code = reason instanceof Error ? reason.message : String(reason);
    const id = FAILURE_IDS.find(([key]) => code.includes(key))?.[1] ?? "engine.connection.failed";
    setMessage({ text: intl.formatMessage({ id }, { engine: engineLabel }), error: true });
  };
  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await action();
      if (done) setMessage({ text: done, error: false });
    } catch (reason) {
      failure(reason);
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    void run(async () => {
      const fields = {
        engine,
        name: form.name,
        mode: form.mode,
        baseUrl: form.mode === "apiKey" ? form.baseUrl : undefined,
        model: form.model,
        apiKey: form.apiKey || undefined,
      };
      await update(
        form.profileId
          ? { type: "edit", profileId: form.profileId, ...fields }
          : { type: "create", ...fields },
      );
      setForm(null);
      return intl.formatMessage(
        { id: form.profileId ? "engine.profile.updated" : "engine.profile.saved" },
        { engine: engineLabel },
      );
    });
  };
  const remove = (profile: ExternalEngineConnectionView) => {
    // 删除只隐藏配置；二次确认避免误删带密钥的配置。
    if (pendingDelete !== profile.id) {
      setPendingDelete(profile.id);
      return;
    }
    setPendingDelete(null);
    void run(async () => {
      await update({ type: "delete", engine, profileId: profile.id });
      return intl.formatMessage({ id: "engine.profile.deleted" });
    });
  };
  const login = (profile: ExternalEngineConnectionView) => {
    setLoggingIn(profile.id);
    void run(async () => {
      try {
        await service.login?.(profile.id);
      } finally {
        setLoggingIn(null);
      }
      return intl.formatMessage({ id: "engine.connection.loggedIn" }, { engine: engineLabel });
    });
  };
  const runTest = (profile: ExternalEngineConnectionView) => {
    if (!workspacePath || !service.testConnection) return;
    setMessage(null);
    setTest({ profileId: profile.id, running: true });
    void service.testConnection({ engine, profileId: profile.id, workspacePath }).then(
      (result) => setTest({ profileId: profile.id, running: false, result }),
      (reason) => {
        setTest(null);
        failure(reason);
      },
    );
  };
  const openForm = (profile?: ExternalEngineConnectionView) => {
    setMessage(null);
    setPendingDelete(null);
    setForm(
      profile && profile.mode !== "inherit"
        ? {
            profileId: profile.id,
            name: profile.name ?? "",
            mode: profile.mode,
            baseUrl: profile.baseUrl ?? officialBaseUrl(engine),
            model: profile.model ?? "",
            apiKey: "",
            hasKey: profile.hasApiKey,
          }
        : {
            name: "",
            mode: "apiKey",
            baseUrl: officialBaseUrl(engine),
            model: "",
            apiKey: "",
            hasKey: false,
          },
    );
  };
  const disabled = loading || busy || !service.updateConnectionProfiles;
  const idPrefix = `engine-connection-${engine}`;
  return (
    <div className="space-y-2" data-testid={`${idPrefix}s`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-ui-base font-medium">
          {intl.formatMessage({ id: "engine.profile.title" })}
        </h4>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || Boolean(form)}
          onClick={() => openForm()}
          data-testid={`${idPrefix}-add`}
        >
          {intl.formatMessage({ id: "engine.profile.add" })}
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border" aria-busy={loading}>
        {profiles.map((profile) => {
          const isDefault = profile.id === defaultId;
          const route = engineConnectionRouteLabel(intl, profile, status);
          const rowTest = test?.profileId === profile.id ? test : null;
          return (
            <li
              key={profile.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              data-testid={`${idPrefix}-${profile.id}`}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ui-base">
                    {profile.builtIn
                      ? intl.formatMessage({ id: `engine.profile.builtin.${profile.id}` })
                      : engineConnectionProfileName(intl, profile)}
                  </span>
                  {isDefault ? (
                    <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "engine.profile.default" })}
                    </span>
                  ) : null}
                </div>
                <div className="break-words text-ui-sm text-foreground-subtle">
                  {engineConnectionModeLabel(intl, profile.mode)}
                  {route ? ` · ${route}` : ""}
                  {profile.model ? ` · ${profile.model}` : ""}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {!isDefault ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void run(async () => {
                        await update({ type: "select", engine, profileId: profile.id });
                        return intl.formatMessage(
                          { id: "engine.profile.selected" },
                          { engine: engineLabel },
                        );
                      })
                    }
                  >
                    {intl.formatMessage({ id: "engine.profile.setDefault" })}
                  </Button>
                ) : null}
                {rowTest?.running ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void service.cancelConnectionTest?.()}
                  >
                    {intl.formatMessage({ id: "engine.profile.cancelTest" })}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || Boolean(test?.running) || !workspacePath}
                    title={
                      workspacePath
                        ? undefined
                        : intl.formatMessage({ id: "engine.profile.testNeedsWorkspace" })
                    }
                    onClick={() => runTest(profile)}
                    data-testid={`${idPrefix}-test-${profile.id}`}
                  >
                    {intl.formatMessage({ id: "engine.profile.test" })}
                  </Button>
                )}
                {profile.mode === "official" && service.login ? (
                  loggingIn === profile.id ? (
                    <Button size="sm" variant="ghost" onClick={() => void service.cancelLogin?.()}>
                      {intl.formatMessage({ id: "common.cancel" })}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || Boolean(loggingIn)}
                      onClick={() => login(profile)}
                    >
                      {intl.formatMessage({ id: "engine.connection.login" })}
                    </Button>
                  )
                ) : null}
                {!profile.builtIn ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || Boolean(form)}
                      onClick={() => openForm(profile)}
                    >
                      {intl.formatMessage({ id: "engine.profile.edit" })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => remove(profile)}
                    >
                      {intl.formatMessage({
                        id:
                          pendingDelete === profile.id
                            ? "engine.profile.confirmDelete"
                            : "engine.profile.delete",
                      })}
                    </Button>
                  </>
                ) : null}
              </div>
              {rowTest ? <ConnectionTestResult test={rowTest} /> : null}
            </li>
          );
        })}
      </ul>
      {form ? (
        <EngineConnectionForm
          engine={engine}
          form={form}
          busy={busy}
          onChange={setForm}
          onSubmit={submit}
          onCancel={() => setForm(null)}
        />
      ) : null}
      {!workspacePath ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "engine.profile.testNeedsWorkspace" })}
        </p>
      ) : null}
      {failed && !connections ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "engine.connection.unreadable" })}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={
            message.error ? "text-ui-sm text-destructive" : "text-ui-sm text-foreground-subtle"
          }
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function ConnectionTestResult({ test }: { test: TestState }) {
  const { intl } = useZCodeIntl();
  const seconds = (latencyMs: number) => (latencyMs / 1000).toFixed(1);
  if (test.running)
    return (
      <p role="status" className="w-full text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.profile.testing" })}
      </p>
    );
  const { result } = test;
  if (result.status === "success")
    return (
      <p role="status" className="w-full text-ui-sm text-foreground-subtle">
        {intl.formatMessage(
          { id: "engine.profile.testSuccess" },
          { seconds: seconds(result.latencyMs) },
        )}
      </p>
    );
  if (result.status === "cancelled")
    return (
      <p role="status" className="w-full text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.profile.testCancelled" })}
      </p>
    );
  if (result.status === "unexpectedReply")
    return (
      <p role="alert" className="w-full break-words text-ui-sm text-warning">
        {intl.formatMessage(
          { id: "engine.profile.testUnexpected" },
          { seconds: seconds(result.latencyMs), reply: result.reply || "—" },
        )}
      </p>
    );
  const { failure } = result;
  const hint = [
    "authentication",
    "timeout",
    "not_ready",
    "configuration",
    "provider",
    "transport",
  ].includes(failure.code)
    ? `engine.profile.testFailure.${failure.code}`
    : "engine.profile.testFailure.other";
  return (
    <div role="alert" className="w-full min-w-0 text-ui-sm text-destructive">
      <p className="break-words">
        {intl.formatMessage(
          { id: "engine.profile.testFailed" },
          { hint: intl.formatMessage({ id: hint }) },
        )}
        {failure.httpStatus ? ` · HTTP ${failure.httpStatus}` : ""}
        {failure.requestId ? ` · request id ${failure.requestId}` : ""}
      </p>
      {failure.message ? <p className="select-text break-words">{failure.message}</p> : null}
      <ErrorDiagnostics
        text={JSON.stringify(failure, null, 2)}
        label={intl.formatMessage({ id: "engine.errorDetails" })}
        copyLabel={intl.formatMessage({ id: "engine.copyErrorDetails" })}
      />
    </div>
  );
}

function EngineConnectionForm({
  engine,
  form,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  engine: ExternalSessionEngine;
  form: FormState;
  busy: boolean;
  onChange: (next: FormState) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const id = (field: string) => `engine-connection-${engine}-${field}`;
  const set = (patch: Partial<FormState>) => onChange({ ...form, ...patch });
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-3"
      onSubmit={onSubmit}
      data-testid={`engine-connection-${engine}-form`}
    >
      <div className="space-y-1">
        <Label htmlFor={id("name")}>{intl.formatMessage({ id: "engine.profile.name" })}</Label>
        <Input
          id={id("name")}
          value={form.name}
          maxLength={ENGINE_CONNECTION_NAME_MAX_LENGTH}
          onChange={(event) => set({ name: event.target.value })}
          disabled={busy}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("mode")}>
          {intl.formatMessage(
            { id: "engine.profile.modeLabel" },
            { engine: ENGINE_LABELS[engine] },
          )}
        </Label>
        <select
          id={id("mode")}
          className="h-9 w-full rounded-lg border border-input-border bg-input px-3 text-ui-base"
          value={form.mode}
          // 连接方式不可原地改写；编辑只能修改同一方式的地址、模型、名称或密钥。
          disabled={busy || Boolean(form.profileId)}
          onChange={(event) => set({ mode: event.target.value as ManagedMode })}
        >
          <option value="official">{engineConnectionModeLabel(intl, "official")}</option>
          <option value="apiKey">{engineConnectionModeLabel(intl, "apiKey")}</option>
        </select>
      </div>
      {form.mode === "apiKey" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor={id("url")}>
              {intl.formatMessage({ id: `engine.profile.url.${engine}` })}
            </Label>
            <Input
              id={id("url")}
              value={form.baseUrl}
              onChange={(event) => set({ baseUrl: event.target.value })}
              disabled={busy}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id("key")}>API Key</Label>
            <Input
              id={id("key")}
              type="password"
              value={form.apiKey}
              onChange={(event) => set({ apiKey: event.target.value })}
              disabled={busy}
              autoComplete="new-password"
              placeholder={
                form.hasKey ? intl.formatMessage({ id: "engine.connection.keySaved" }) : undefined
              }
            />
          </div>
        </>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={id("model")}>{intl.formatMessage({ id: "engine.connection.model" })}</Label>
        <Input
          id={id("model")}
          value={form.model}
          onChange={(event) => set({ model: event.target.value })}
          disabled={busy}
          autoComplete="off"
        />
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.connection.hint" })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="outline"
          disabled={busy || (form.mode === "apiKey" && !form.apiKey.trim() && !form.hasKey)}
        >
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </div>
    </form>
  );
}
