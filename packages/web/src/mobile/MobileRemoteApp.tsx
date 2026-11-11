/**
 * 手机远控外壳：配对（链接 / 页面内扫码 / 手输配对码）/ 选主机 / 选窗口 / 断线重连，
 * 接入后渲染与 Web 端相同的 Root。
 * 会话投影由 Host 订阅的快照与续传恢复；外壳不缓存会话数据、不保存待发送队列。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MobileRemoteConnectError,
  connectMobileRemote,
  lookupMobileRemotePairing,
  type MobileRemoteConnectErrorCode,
  type MobileRemoteSession,
} from "@zcode/client";
import {
  parseMobileRemotePairingHash,
  parseMobileRemotePairingInput,
  type MobileRemotePairingInput,
  type MobileRemoteWindow,
} from "@zcode/shared/mobile-remote";
import { AppErrorBoundary, Button, Input, Root, ZCodeIntlProvider } from "@zcode/ui";
import { createWebPlatform } from "../platform/webPlatform.js";
import {
  describeDevice,
  listPairedHosts,
  loadDeviceKey,
  removePairedHost,
  rememberWindow,
  savePairedHost,
} from "./identity.js";
import type { PairedHost } from "./contract.js";
import { QrScanner } from "./QrScanner.js";
import { mobileStrings as t, type MobileStringKey } from "./strings.js";

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000];

type ScreenState =
  | { kind: "hosts" }
  | { kind: "connecting"; host: PairedHost; pairing: boolean }
  | {
      kind: "choose-window";
      host: PairedHost;
      windows: MobileRemoteWindow[];
      choose: (windowId: number | null) => void;
    }
  | {
      kind: "connected";
      host: PairedHost;
      session: MobileRemoteSession;
      workspacePath?: string;
      initialTaskId?: string;
      generation: number;
      reconnecting: boolean;
    }
  | { kind: "error"; host: PairedHost; code: MobileRemoteConnectErrorCode; pairing: boolean };

const ERROR_TEXT: Partial<Record<MobileRemoteConnectErrorCode, MobileStringKey>> = {
  host_offline: "errorHostOffline",
  unknown_device: "errorUnknownDevice",
  revoked: "errorUnknownDevice",
  host_key_mismatch: "errorHostKeyMismatch",
  window_unavailable: "errorWindowUnavailable",
  no_window: "errorNoWindow",
  timeout: "errorTimeout",
  pairing_not_found: "errorPairingNotFound",
  rate_limited: "errorRateLimited",
};

function errorTextKey(code: MobileRemoteConnectErrorCode, pairing: boolean): MobileStringKey {
  // 配对时主机拒绝 = 配对码错误或已作废，与「已配对设备被移除」区分提示。
  if (pairing && code === "unknown_device") return "errorPairingRejected";
  return ERROR_TEXT[code] ?? "errorGeneric";
}

/** 页面内配对输入的本地错误（不经网络即可判定）。 */
class PairInputError extends Error {
  constructor(readonly key: MobileStringKey) {
    super(key);
  }
}

/** 需要重新配对的错误：不自动重连，并从本机列表移除该主机。 */
function requiresRepair(code: MobileRemoteConnectErrorCode): boolean {
  return code === "unknown_device" || code === "revoked" || code === "host_key_mismatch";
}

function pickWindowSilently(windows: MobileRemoteWindow[], preferred?: number): number | null {
  if (windows.length === 0) return null;
  if (preferred !== undefined && windows.some((w) => w.windowId === preferred)) return preferred;
  return (windows.find((w) => w.focused) ?? windows[0]!).windowId;
}

const basePlatform = createWebPlatform();

export function MobileRemoteApp() {
  const [screen, setScreen] = useState<ScreenState>({ kind: "hosts" });
  const [hosts, setHosts] = useState<PairedHost[]>(() => listPairedHosts());
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(0);
  const generation = useRef(0);
  // 当前会话只记在内存：重连后以 initialTaskId 重建 Root，回到断线前的会话。
  const activeTaskIdRef = useRef<string | null>(null);
  const platform = useMemo(
    () => ({
      ...basePlatform,
      syncActiveTaskSession: (sessionId: string | null) => {
        activeTaskIdRef.current = sessionId;
      },
    }),
    [],
  );

  const refreshHosts = useCallback(() => setHosts(listPairedHosts()), []);

  const clearReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
  }, []);
  // connect 与重连调度互相引用：调度经 ref 取最新的 connect，两者都保持引用稳定。
  const connectRef = useRef<(host: PairedHost, options?: { silent?: boolean }) => Promise<void>>(
    async () => {},
  );
  const scheduleReconnect = useCallback(
    (host: PairedHost) => {
      clearReconnect();
      const delay =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt.current, RECONNECT_DELAYS_MS.length - 1)]!;
      reconnectAttempt.current += 1;
      reconnectTimer.current = setTimeout(
        () => void connectRef.current(host, { silent: true }),
        delay,
      );
    },
    [clearReconnect],
  );

  const connect = useCallback(
    async (host: PairedHost, options: { pairingCode?: string; silent?: boolean } = {}) => {
      clearReconnect();
      if (!options.silent)
        setScreen({ kind: "connecting", host, pairing: Boolean(options.pairingCode) });
      let chosenWorkspace: string | undefined;
      try {
        const session = await connectMobileRemote({
          relayUrl: host.relayUrl,
          hostId: host.hostId,
          deviceKey: loadDeviceKey(),
          deviceName: describeDevice(),
          ...(options.pairingCode ? { pairingCode: options.pairingCode } : {}),
          chooseWindow: (windows) => {
            // 重连与单窗口时静默选择；多窗口首次连接让用户挑选。
            const silentPick =
              options.silent || windows.length <= 1
                ? pickWindowSilently(windows, host.lastWindowId)
                : undefined;
            if (silentPick !== undefined) {
              chosenWorkspace = windows.find((w) => w.windowId === silentPick)?.workspacePath;
              return silentPick;
            }
            return new Promise<number | null>((resolve) => {
              setScreen({
                kind: "choose-window",
                host,
                windows,
                choose: (windowId) => {
                  chosenWorkspace = windows.find((w) => w.windowId === windowId)?.workspacePath;
                  if (windowId !== null) setScreen({ kind: "connecting", host, pairing: false });
                  resolve(windowId);
                },
              });
            });
          },
        });
        reconnectAttempt.current = 0;
        const saved: PairedHost = {
          ...host,
          hostName: session.hostName || host.hostName,
          lastWindowId: session.windowId,
        };
        savePairedHost(saved);
        rememberWindow(saved.hostId, session.windowId);
        refreshHosts();
        generation.current += 1;
        // 只有静默重连才恢复会话；用户主动换主机 / 窗口时从窗口当前工作区开始。
        const restoreTaskId = options.silent ? activeTaskIdRef.current : null;
        setScreen({
          kind: "connected",
          host: saved,
          session,
          ...(chosenWorkspace ? { workspacePath: chosenWorkspace } : {}),
          ...(restoreTaskId && chosenWorkspace ? { initialTaskId: restoreTaskId } : {}),
          generation: generation.current,
          reconnecting: false,
        });
        session.onClose((info) => {
          const current = screenRef.current;
          if (current.kind !== "connected" || current.session !== session) return;
          const code = info.error;
          if (code && requiresRepair(code)) {
            removePairedHost(host.hostId);
            refreshHosts();
            setScreen({ kind: "error", host: saved, code, pairing: false });
            return;
          }
          setScreen({ ...current, reconnecting: true });
          scheduleReconnect(saved);
        });
      } catch (error) {
        const code = error instanceof MobileRemoteConnectError ? error.code : "network";
        const current = screenRef.current;
        const pairing = Boolean(options.pairingCode);
        if (requiresRepair(code)) {
          removePairedHost(host.hostId);
          refreshHosts();
          setScreen({ kind: "error", host, code, pairing });
          return;
        }
        // 已接入状态下的重连失败保持 Root 与遮罩，继续退避重试。
        if (options.silent && current.kind === "connected") {
          scheduleReconnect(host);
          return;
        }
        if (code === "no_window" && current.kind === "hosts") return;
        setScreen({ kind: "error", host, code, pairing });
      }
    },
    [refreshHosts, clearReconnect, scheduleReconnect],
  );
  connectRef.current = connect;

  /**
   * 页面内配对：配对链接直接带 hostId；手输配对码先经中继查询 hostId。
   * 查询失败抛给输入面板就地提示；进入握手后由 connect 接管界面状态。
   */
  const pairWith = useCallback(
    async (input: MobileRemotePairingInput) => {
      const relayUrl = window.location.origin;
      if (input.kind === "link") {
        // 手机只连接当前页面所在的中继；其他中继的二维码应在其地址打开。
        if (input.relayOrigin !== relayUrl) throw new PairInputError("qrOtherRelay");
        void connect(
          {
            hostId: input.payload.hostId,
            hostName: input.payload.hostName,
            relayUrl,
            pairedAt: Date.now(),
          },
          { pairingCode: input.payload.pairingCode },
        );
        return;
      }
      const { hostId } = await lookupMobileRemotePairing(relayUrl, input.code);
      // 主机名在 welcome 中由主机告知，连接成功后覆盖占位名。
      void connect(
        { hostId, hostName: t.unknownHostName, relayUrl, pairedAt: Date.now() },
        { pairingCode: input.code },
      );
    },
    [connect],
  );

  // 首次进入：处理扫码配对链接；否则只有一台电脑时直接连接。
  useEffect(() => {
    const pairing = parseMobileRemotePairingHash(window.location.hash);
    if (pairing) {
      // 配对码只用一次，立即从地址栏移除，避免被截图或历史记录泄露。
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void connect(
        {
          hostId: pairing.hostId,
          hostName: pairing.hostName,
          relayUrl: window.location.origin,
          pairedAt: Date.now(),
        },
        { pairingCode: pairing.pairingCode },
      );
      return;
    }
    const paired = listPairedHosts();
    if (paired.length === 1) void connect(paired[0]!);
    return clearReconnect;
  }, [connect, clearReconnect]);

  // 手机从后台回到前台时立即重连，不等退避计时。
  useEffect(() => {
    const onVisible = () => {
      const current = screenRef.current;
      if (
        document.visibilityState === "visible" &&
        current.kind === "connected" &&
        current.reconnecting
      ) {
        reconnectAttempt.current = 0;
        void connect(current.host, { silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [connect]);

  if (screen.kind === "connected") {
    const { session } = screen;
    return (
      <div className="relative h-full w-full">
        <AppErrorBoundary key={screen.generation}>
          <ZCodeIntlProvider
            settingService={session.services.settingService}
            broadcastService={session.services.broadcastService}
          >
            <Root
              services={session.services}
              platform={platform}
              initialWorkspaceAbsPath={screen.workspacePath}
              initialTaskId={screen.initialTaskId}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </ZCodeIntlProvider>
        </AppErrorBoundary>
        {screen.reconnecting ? (
          <div
            role="status"
            aria-live="polite"
            className="bg-background/80 absolute inset-0 z-[1000] flex items-center justify-center backdrop-blur-sm"
          >
            <div className="bg-card text-foreground border-border rounded-lg border px-4 py-3 text-ui-base shadow-sm">
              {t.reconnecting}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <main className="bg-background text-foreground flex h-full w-full flex-col items-center overflow-y-auto px-5 py-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-ui-xl font-semibold">{t.title}</h1>
          <p className="text-muted-foreground text-ui-sm">{t.trustNote}</p>
        </header>
        {screen.kind === "hosts" ? (
          <>
            <HostList
              hosts={hosts}
              onConnect={(host) => void connect(host)}
              onRemove={(host) => {
                removePairedHost(host.hostId);
                refreshHosts();
              }}
            />
            <PairPanel onPair={pairWith} />
          </>
        ) : null}
        {screen.kind === "connecting" ? (
          <p role="status" className="text-ui-base">
            {screen.pairing ? t.pairing : t.connecting}
            <span className="text-muted-foreground"> {screen.host.hostName}</span>
          </p>
        ) : null}
        {screen.kind === "choose-window" ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-ui-lg font-medium">{t.chooseWindow}</h2>
            {screen.windows.map((win) => (
              <button
                key={win.windowId}
                type="button"
                onClick={() => screen.choose(win.windowId)}
                className="border-border bg-card hover:bg-accent flex items-center justify-between rounded-lg border px-4 py-3 text-left"
              >
                <span className="text-ui-base truncate">{win.title}</span>
                {win.focused ? (
                  <span className="text-muted-foreground text-ui-xs shrink-0">
                    {t.focusedWindow}
                  </span>
                ) : null}
              </button>
            ))}
            <Button
              variant="ghost"
              onClick={() => {
                screen.choose(null);
                setScreen({ kind: "hosts" });
              }}
            >
              {t.back}
            </Button>
          </section>
        ) : null}
        {screen.kind === "error" ? (
          <section role="alert" className="flex flex-col gap-3">
            <p className="text-ui-base">{t[errorTextKey(screen.code, screen.pairing)]}</p>
            <div className="flex gap-2">
              {requiresRepair(screen.code) || screen.pairing ? null : (
                <Button onClick={() => void connect(screen.host)}>{t.retry}</Button>
              )}
              <Button variant="outline" onClick={() => setScreen({ kind: "hosts" })}>
                {t.back}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function HostList(props: {
  hosts: PairedHost[];
  onConnect: (host: PairedHost) => void;
  onRemove: (host: PairedHost) => void;
}) {
  if (props.hosts.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-ui-lg font-medium">{t.noHosts}</h2>
        <p className="text-muted-foreground text-ui-base">{t.noHostsHint}</p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-ui-lg font-medium">{t.pairedHosts}</h2>
      {props.hosts.map((host) => (
        <div
          key={host.hostId}
          className="border-border bg-card flex items-center justify-between gap-2 rounded-lg border px-4 py-3"
        >
          <span className="text-ui-base truncate">{host.hostName}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => props.onConnect(host)}>
              {t.connect}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => props.onRemove(host)}>
              {t.remove}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** 输入时格式化为 `XXXX-XXXX`；看起来像链接时保持原样（支持直接粘贴配对链接）。 */
function formatPairInput(value: string): string {
  if (/[:/.#]/.test(value)) return value.trim();
  const compact = value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

function PairPanel(props: { onPair: (input: MobileRemotePairingInput) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<MobileStringKey | null>(null);

  const submit = useCallback(
    async (text: string) => {
      const input = parseMobileRemotePairingInput(text);
      if (!input) {
        setMessage("inputUnrecognized");
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        await props.onPair(input);
      } catch (error) {
        if (error instanceof PairInputError) setMessage(error.key);
        else if (error instanceof MobileRemoteConnectError)
          setMessage(errorTextKey(error.code, true));
        else setMessage("errorGeneric");
      } finally {
        setBusy(false);
      }
    },
    [props],
  );

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-ui-lg font-medium">{t.addHost}</h2>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(value);
        }}
      >
        <Input
          size="lg"
          value={value}
          onChange={(event) => {
            setValue(formatPairInput(event.target.value));
            setMessage(null);
          }}
          placeholder={t.pairInputPlaceholder}
          aria-label={t.pairInputPlaceholder}
          aria-invalid={message ? true : undefined}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          // iOS Safari 对小于 16px 的输入框聚焦时会自动放大页面，配对页只在手机使用，固定 16px。
          className="min-w-0 flex-1 font-mono text-mobile-input-safe tracking-wider"
        />
        <Button type="submit" size="lg" disabled={busy || value.trim().length === 0}>
          {t.pairSubmit}
        </Button>
      </form>
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={busy}
        onClick={() => {
          setMessage(null);
          setScanning(true);
        }}
      >
        {t.scan}
      </Button>
      {message ? (
        <p role="alert" className="text-destructive text-ui-sm">
          {t[message]}
        </p>
      ) : null}
      {scanning ? (
        <QrScanner
          onResult={(text) => {
            setScanning(false);
            void submit(text);
          }}
          onFailure={(failure) => {
            setScanning(false);
            setMessage(failure === "denied" ? "cameraDenied" : "cameraUnavailable");
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </section>
  );
}
