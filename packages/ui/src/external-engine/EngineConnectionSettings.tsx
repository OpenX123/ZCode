import { useEffect, useState } from "react";
import type { ExternalEngineConnectionProfile } from "@zcode/shared/external-engine";
import { useExternalEngineService } from "@/hooks/external-engine/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";

export function EngineConnectionSettings() {
  const service = useExternalEngineService();
  const { intl } = useZCodeIntl();
  const [mode, setMode] = useState<ExternalEngineConnectionProfile["mode"]>("inherit");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const failureMessage = (reason: unknown): string => {
    // 只把受控错误码映射为操作提示，不回显可能包含认证数据的原始异常。
    const code = reason instanceof Error ? reason.message : String(reason);
    const id = code.includes("connection_url_invalid")
      ? "invalidUrl"
      : code.includes("api_key_missing")
        ? "missingKey"
        : code.includes("engine_not_ready")
          ? "engineMissing"
          : code.includes("process_interrupted")
            ? "interrupted"
            : code.includes("login_failed")
              ? "loginFailed"
              : code.includes("connections_unreadable")
                ? "unreadable"
                : "failed";
    return intl.formatMessage({ id: `engine.connection.${id}` });
  };
  useEffect(() => {
    if (!service?.getConnectionProfiles) return;
    let current = true;
    setLoading(true);
    void service
      .getConnectionProfiles()
      .then((value) => {
        if (!current) return;
        const profile = value.profiles.find((item) => item.id === value.activeProfileId);
        if (!profile) return;
        setMode(profile.mode);
        setBaseUrl(profile.baseUrl ?? "https://api.openai.com/v1");
        setModel(profile.model ?? "");
        setHasKey(profile.hasApiKey);
      })
      .catch(() => {
        if (current) {
          setMessage(intl.formatMessage({ id: "engine.connection.failed" }));
          setError(true);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [service, intl]);
  if (!service?.saveConnectionProfile) return null;
  const save = async (login: boolean) => {
    setBusy(true);
    setMessage(null);
    setError(false);
    try {
      const profile = await service.saveConnectionProfile!({
        mode,
        baseUrl: mode === "apiKey" ? baseUrl : undefined,
        model,
        apiKey: apiKey || undefined,
      });
      setApiKey("");
      setHasKey(profile.hasApiKey);
      if (login) {
        setLoggingIn(true);
        await service.login?.(profile.id);
      }
      setMessage(
        intl.formatMessage({
          id: login ? "engine.connection.loggedIn" : "engine.connection.saved",
        }),
      );
    } catch (reason) {
      setMessage(failureMessage(reason));
      setError(true);
    } finally {
      setBusy(false);
      setLoggingIn(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="codex-connection-settings">
      <div className="space-y-1">
        <Label htmlFor="codex-connection-mode">
          {intl.formatMessage({ id: "engine.connection.mode" })}
        </Label>
        <select
          id="codex-connection-mode"
          className="h-9 w-full rounded-md border border-input-border bg-input px-3 text-ui-base"
          value={mode}
          disabled={loading || busy}
          onChange={(event) => {
            setMode(event.target.value as typeof mode);
            setMessage(null);
          }}
        >
          <option value="inherit">{intl.formatMessage({ id: "engine.connection.inherit" })}</option>
          <option value="official">
            {intl.formatMessage({ id: "engine.connection.official" })}
          </option>
          <option value="apiKey">{intl.formatMessage({ id: "engine.connection.apiKey" })}</option>
        </select>
      </div>
      {mode === "apiKey" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="codex-base-url">
              {intl.formatMessage({ id: "engine.connection.url" })}
            </Label>
            <Input
              id="codex-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="codex-api-key">API Key</Label>
            <Input
              id="codex-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={busy}
              autoComplete="new-password"
              placeholder={
                hasKey ? intl.formatMessage({ id: "engine.connection.keySaved" }) : undefined
              }
            />
          </div>
        </>
      ) : null}
      {mode !== "inherit" ? (
        <div className="space-y-1">
          <Label htmlFor="codex-default-model">
            {intl.formatMessage({ id: "engine.connection.model" })}
          </Label>
          <Input
            id="codex-default-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </div>
      ) : null}
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "engine.connection.hint" })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={loading || busy || (mode === "apiKey" && !apiKey.trim() && !hasKey)}
          onClick={() => void save(false)}
        >
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        {mode === "official" ? (
          <Button disabled={loading || busy} onClick={() => void save(true)}>
            {intl.formatMessage({ id: "engine.connection.login" })}
          </Button>
        ) : null}
        {loggingIn ? (
          <Button variant="outline" onClick={() => void service.cancelLogin?.()}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        ) : null}
      </div>
      {message ? (
        <p
          role={error ? "alert" : "status"}
          className={error ? "text-ui-sm text-destructive" : "text-ui-sm text-foreground-subtle"}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
