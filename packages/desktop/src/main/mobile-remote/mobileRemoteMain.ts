/**
 * 手机远控在 Electron Main 中的装配：把窗口 Host 进程映射适配为网关的 attach 端口，
 * 注册设置页 IPC，并把状态变化广播给所有窗口。网关只做转发，不持有会话状态。
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  BrowserWindow,
  MessageChannelMain,
  app,
  ipcMain,
  type MessagePortMain,
  type UtilityProcess,
} from "electron";
import { HostMessageTypes, PlatformChannels } from "@zcode/shared";
import type { MobileRemoteConfigInput, MobileRemoteWindow } from "@zcode/shared/mobile-remote";
import type { MobileRemoteGateway, MobileRemoteHostPort } from "./contract.js";
import { createMobileRemoteGateway } from "./mobileRemoteGateway.js";
import { createMobileRemoteStore } from "./mobileRemoteStore.js";

interface MobileRemoteMainOptions {
  /** key 为 webContents.id */
  windowHostProcessMap: Map<number, UtilityProcess>;
  /** key 为 BrowserWindow.id，值为窗口内的工作区 key */
  windowWorkspaceMap: Map<number, Set<string>>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

function adaptPort(
  process: UtilityProcess,
  attachmentId: string,
  port: MessagePortMain,
): MobileRemoteHostPort {
  let closed = false;
  const closeHandlers: Array<() => void> = [];
  port.on("close", () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  });
  return {
    postRpc(message) {
      if (!closed) port.postMessage(message);
    },
    postFlowState(state) {
      if (!closed) port.postMessage({ __zcodeRpcControl: "connection-flow-v1", state });
    },
    onRpc(handler) {
      port.on("message", (event) => {
        // 只有 Uint8Array 是 RPC；Host 侧的 control object 不转发给手机。
        if (event.data instanceof Uint8Array) handler(event.data);
      });
      // 在挂上监听后才 start，Host 的 Initialize 会排在端口队列里，不会丢失。
      port.start();
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        process.postMessage({ type: HostMessageTypes.DetachServicePort, attachmentId });
      } catch {
        // Host 已退出时 detach 无意义。
      }
      port.close();
    },
  };
}

/** windowWorkspaceMap 的值是 workspace key；本期只接本地工作区，取第一个绝对路径。 */
function windowWorkspacePath(workspaces: Set<string> | undefined): string | undefined {
  return workspaces ? [...workspaces].find((key) => isAbsolute(key)) : undefined;
}

function windowTitle(win: BrowserWindow, workspacePath: string | undefined): string {
  if (workspacePath) return basename(workspacePath) || workspacePath;
  return win.getTitle() || `窗口 ${win.id}`;
}

export function startMobileRemote(options: MobileRemoteMainOptions): MobileRemoteGateway {
  let lastFocusedWindowId: number | null = null;
  app.on("browser-window-focus", (_event, win) => {
    lastFocusedWindowId = win.id;
  });

  function listWindows(): MobileRemoteWindow[] {
    return BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && options.windowHostProcessMap.has(win.webContents.id))
      .map((win) => {
        const workspacePath = windowWorkspacePath(options.windowWorkspaceMap.get(win.id));
        return {
          windowId: win.id,
          title: windowTitle(win, workspacePath).slice(0, 200),
          focused: win.id === lastFocusedWindowId,
          ...(workspacePath ? { workspacePath } : {}),
        };
      });
  }

  function attachWindow(windowId: number): MobileRemoteHostPort | null {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return null;
    const process = options.windowHostProcessMap.get(win.webContents.id);
    if (!process) return null;
    const { port1, port2 } = new MessageChannelMain();
    const attachmentId = `mobile-remote-${randomUUID()}`;
    // 与 renderer reload 复用同一 AttachServicePort 通道；replayable 模式受 Host 白名单约束。
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId,
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [port2],
    );
    return adaptPort(process, attachmentId, port1);
  }

  const gateway = createMobileRemoteGateway({
    store: createMobileRemoteStore(join(app.getPath("userData"), "mobile-remote")),
    hostName: () => hostname().replace(/\.local$/, ""),
    listWindows,
    attachWindow,
    logger: options.logger,
    onStatusChanged: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(PlatformChannels.MobileRemoteStatusChanged, status);
      }
    },
  });

  const started = gateway.start().catch((error: unknown) => {
    options.logger.warn("[mobile-remote] start failed", error);
  });

  ipcMain.handle(PlatformChannels.GetMobileRemoteStatus, async () => {
    await started;
    return gateway.getStatus();
  });
  ipcMain.handle(
    PlatformChannels.SetMobileRemoteConfig,
    async (_event, input: MobileRemoteConfigInput) => {
      await started;
      return gateway.setConfig({
        enabled: Boolean(input?.enabled),
        relayUrl: String(input?.relayUrl ?? ""),
        ...(typeof input?.relayToken === "string" ? { relayToken: input.relayToken } : {}),
      });
    },
  );
  ipcMain.handle(PlatformChannels.CreateMobileRemotePairing, async () => {
    await started;
    return gateway.createPairing();
  });
  ipcMain.handle(PlatformChannels.RevokeMobileRemoteDevice, async (_event, deviceId: string) => {
    await started;
    return gateway.revokeDevice(String(deviceId));
  });

  app.once("will-quit", () => gateway.dispose());
  return gateway;
}
