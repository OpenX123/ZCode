// 设置页「手机远控」分区（仅桌面端）：开关、自托管中继配置、扫码 / 配对码配对与已配对设备管理。
// 状态唯一所有者是 Main 网关（docs/desktop/mobile-remote-spec.md），本组件只读状态并发送命令。
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MobileRemotePairingTicket, MobileRemoteStatus } from "@zcode/shared/mobile-remote";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";

const RELAY_TONE: Record<MobileRemoteStatus["relay"], StatusDotTone> = {
  disabled: "muted",
  connecting: "amber",
  online: "green",
  offline: "red",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MobileRemoteSection() {
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const [status, setStatus] = useState<MobileRemoteStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [relayToken, setRelayToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState<(MobileRemotePairingTicket & { qr: string }) | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void platform.getMobileRemoteStatus?.().then((next) => {
      if (cancelled) return;
      setStatus(next);
      setRelayUrl(next.relayUrl);
    });
    const dispose = platform.onMobileRemoteStatusChanged?.((next) => setStatus(next));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform]);

  // 二维码倒计时；过期后收起，避免用户扫描已失效的码。
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  useEffect(() => {
    if (pairing && now >= pairing.expiresAt) setPairing(null);
  }, [now, pairing]);

  // 配对成功（设备数增加）后自动收起二维码。
  const deviceCount = status?.devices.length ?? 0;
  const [pairingBaseline, setPairingBaseline] = useState(0);
  useEffect(() => {
    if (pairing && deviceCount > pairingBaseline) {
      setPairing(null);
      toast(formatMessage({ id: "settings.mobileRemote.pairedToast" }));
    }
  }, [deviceCount, pairing, pairingBaseline, formatMessage]);

  const save = useCallback(
    async (enabled: boolean) => {
      if (!platform.setMobileRemoteConfig) return;
      setSaving(true);
      try {
        const next = await platform.setMobileRemoteConfig({
          enabled,
          relayUrl,
          ...(relayToken ? { relayToken } : {}),
        });
        setStatus(next);
        setRelayUrl(next.relayUrl);
        setRelayToken("");
        if (!enabled) setPairing(null);
      } catch (error) {
        toast(errorMessage(error), { variant: "warning" });
      } finally {
        setSaving(false);
      }
    },
    [platform, relayUrl, relayToken],
  );

  const startPairing = useCallback(async () => {
    if (!platform.createMobileRemotePairing) return;
    try {
      const ticket = await platform.createMobileRemotePairing();
      const qr = await QRCode.toDataURL(ticket.url, { margin: 1, width: 240 });
      setPairingBaseline(deviceCount);
      setNow(Date.now());
      setPairing({ ...ticket, qr });
    } catch (error) {
      toast(errorMessage(error), { variant: "warning" });
    }
  }, [platform, deviceCount]);

  const revoke = useCallback(
    async (deviceId: string) => {
      try {
        const next = await platform.revokeMobileRemoteDevice?.(deviceId);
        if (next) setStatus(next);
      } catch (error) {
        toast(errorMessage(error), { variant: "warning" });
      }
    },
    [platform],
  );

  if (!status) return null;

  const configDirty = relayUrl.trim() !== status.relayUrl || relayToken.length > 0;
  const remainingSeconds = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-base text-muted-foreground">
        {formatMessage({ id: "settings.mobileRemote.description" })}
      </p>
      <SettingsGroupCard>
        <SettingsRow
          label={formatMessage({ id: "settings.mobileRemote.enable" })}
          description={
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={RELAY_TONE[status.relay]} />
              {formatMessage({ id: `settings.mobileRemote.relay.${status.relay}` })}
              {status.lastError && status.relay !== "online" ? ` · ${status.lastError}` : ""}
            </span>
          }
          control={
            <Switch
              checked={status.enabled}
              disabled={saving}
              aria-label={formatMessage({ id: "settings.mobileRemote.enable" })}
              onCheckedChange={(checked) => void save(checked)}
            />
          }
        />
        <SettingsRow
          label={formatMessage({ id: "settings.mobileRemote.relayUrl" })}
          description={formatMessage({ id: "settings.mobileRemote.relayUrlHint" })}
          controlLayout="wide"
          control={
            <Input
              value={relayUrl}
              placeholder="https://relay.example.com"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setRelayUrl(event.target.value)}
            />
          }
        />
        <SettingsRow
          label={formatMessage({ id: "settings.mobileRemote.relayToken" })}
          controlLayout="wide"
          control={
            <Input
              type="password"
              value={relayToken}
              autoComplete="off"
              placeholder={
                status.hasRelayToken
                  ? formatMessage({ id: "settings.mobileRemote.relayTokenSaved" })
                  : ""
              }
              onChange={(event) => setRelayToken(event.target.value)}
            />
          }
        />
        {configDirty ? (
          <div className="flex justify-end border-t border-border px-4 py-3">
            <Button size="sm" disabled={saving} onClick={() => void save(status.enabled)}>
              {formatMessage({ id: "settings.mobileRemote.save" })}
            </Button>
          </div>
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={formatMessage({ id: "settings.mobileRemote.pairTitle" })}
          description={formatMessage({ id: "settings.mobileRemote.pairHint" })}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!status.enabled || status.relay !== "online"}
              onClick={() => void startPairing()}
            >
              {formatMessage({ id: "settings.mobileRemote.pairButton" })}
            </Button>
          }
          detail={
            pairing ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <img
                  src={pairing.qr}
                  width={240}
                  height={240}
                  alt={formatMessage({ id: "settings.mobileRemote.qrAlt" })}
                  className="rounded-lg bg-white p-2"
                />
                <span className="text-ui-sm text-muted-foreground">
                  {formatMessage({ id: "settings.mobileRemote.pairCodeLabel" })}
                </span>
                {/* 手输配对码：手机网页内输入即可配对，不依赖摄像头 */}
                <span className="font-mono text-ui-xl font-semibold tracking-widest select-all">
                  {pairing.code}
                </span>
                <span className="text-ui-sm text-muted-foreground">
                  {formatMessage(
                    { id: "settings.mobileRemote.qrExpires" },
                    { seconds: remainingSeconds },
                  )}
                </span>
              </div>
            ) : undefined
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <div className="px-4 py-3 text-ui-base font-medium">
          {formatMessage({ id: "settings.mobileRemote.devices" })}
        </div>
        {status.devices.length === 0 ? (
          <div className="border-t border-border px-4 py-3 text-ui-sm text-muted-foreground">
            {formatMessage({ id: "settings.mobileRemote.noDevices" })}
          </div>
        ) : (
          status.devices.map((device) => (
            <SettingsRow
              key={device.id}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={device.connected ? "green" : "muted"} />
                  {device.name}
                </span>
              }
              description={formatMessage(
                { id: "settings.mobileRemote.devicePaired" },
                {
                  date: new Date(device.pairedAt).toLocaleString(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                },
              )}
              control={
                <Button size="sm" variant="ghost" onClick={() => void revoke(device.id)}>
                  {formatMessage({ id: "settings.mobileRemote.remove" })}
                </Button>
              }
            />
          ))
        )}
      </SettingsGroupCard>

      <p className="text-ui-sm text-muted-foreground">
        {formatMessage({ id: "settings.mobileRemote.trustNote" })}
      </p>
    </div>
  );
}
