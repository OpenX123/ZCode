import { normalizeRemoteConnectionError } from "@zcode/shared";
/* eslint-disable max-lines -- 远程连接、OAuth 回调、遥测和通知 IPC 共用窗口级上下文，集中注册避免跨文件状态漂移。 */
import { BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import {
  formatZodError,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  normalizeUnknownError,
  InternalChannels,
  isPublicZCodeErrorCode,
  PlatformChannels,
  remoteTargetSchema,
  type BindRemoteWorkspaceSessionContextIpcResult,
  type RemoteTarget,
  type WindowHostRemoteWorkspaceDescriptor,
  type BindRemoteWorkspaceSessionContextResult,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import { deliverPendingDeepLink } from "./desktopOAuthDeepLink.js";
import { openFileUrlInDefaultApp, openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isPublicRemoteReasonCode(code: string | undefined): code is string {
  // Bug 原因：前缀 OR 形成第二份公开码真源，任何内部 source-server-* 字符串都会穿透
  // Main 暴露给 Renderer。公开边界只消费 shared 登记表，新增码必须先进入统一合同。
  return isPublicZCodeErrorCode(code);
}

function readRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) return undefined;
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

function toBindIpcFailure(error: unknown): BindRemoteWorkspaceSessionContextIpcResult {
  const normalized = normalizeUnknownError(error);
  const reasonCode = isPublicRemoteReasonCode(normalized.code) ? normalized.code : undefined;
  const retryable = reasonCode ? readRetryable(error) : undefined;
  return {
    success: false,
    error: normalized.message,
    ...(reasonCode ? { reasonCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

export function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      confirmSourceServerInstall?: boolean;
    },
    lifecycle?: {
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: {
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
    expectedWebContentsId?: number,
  ) => Promise<BindRemoteWorkspaceSessionContextResult>;
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  attachSourceSettings?: (sender: WebContents, sourceServerId: string) => { attachmentId: string };
  isDockerDaemonAvailable: () => Promise<boolean>;
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listAvailableDockerContainers: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as {
      sessionId?: unknown;
      attachmentId?: unknown;
    };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    if (!sessionId || !attachmentId) return;
    options.confirmRendererAttachmentReady(event.sender.id, {
      sessionId,
      attachmentId,
    });
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    if (new URL(url).protocol === "file:") {
      void openFileUrlInDefaultApp(url, options.logger);
      return;
    }
    const sender = event.sender;
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] 外部 URL 打开失败", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    deliverPendingDeepLink(event.sender);
  });

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
      confirmSourceServerInstall?: unknown;
    } =
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
            confirmSourceServerInstall?: unknown;
          })
        : { target: rawPayload, requestId: undefined };
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;
    const confirmSourceServerInstall = wrappedPayload.confirmSourceServerInstall === true;

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("未找到当前窗口，无法创建远程 session");
      }

      let reusedConnectionTarget: RemoteTarget | undefined;
      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath || confirmSourceServerInstall
          ? {
              workspacePath,
              workspaceIdentity,
              ...(confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
            }
          : undefined,
        {
          onConnected: (descriptor) => {
            reusedConnectionTarget = descriptor.reusedConnectionTarget;
          },
        },
      );
      return {
        success: true,
        sessionId,
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
      };
    } catch (error) {
      const normalizedError = normalizeRemoteConnectionError(error);
      // 这里之前直接把 Error 对象交给 logger，落盘时会被 JSON.stringify 压成 `{}`。
      // 改成显式展开 message/code/stack，保证远程建连失败时主进程日志里能看到真实上下文。
      options.logger.error("[connect-remote] caught error:", {
        requestId,
        confirmSourceServerInstall,
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      const reasonCode = isPublicRemoteReasonCode(normalizedError.code)
        ? normalizedError.code
        : undefined;
      const retryable = reasonCode ? readRetryable(error) : undefined;
      const profileId = hostRemoteWorkspaceConnectFailedResponseSchema.shape.profileId.safeParse(
        (reasonCode === "source-server-upgrade-required" ||
          reasonCode === "source-server-install-required") &&
          error &&
          typeof error === "object" &&
          "profileId" in error
          ? error.profileId
          : undefined,
      );
      const resolvedWslTarget =
        hostRemoteWorkspaceConnectFailedResponseSchema.shape.resolvedWslTarget.safeParse(
          (reasonCode === "source-server-install-required" ||
            reasonCode === "source-server-upgrade-required") &&
            error &&
            typeof error === "object" &&
            "resolvedWslTarget" in error
            ? error.resolvedWslTarget
            : undefined,
        );
      return {
        success: false,
        error: normalizedError.message,
        ...(reasonCode ? { reasonCode } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
        ...(profileId.success && profileId.data ? { profileId: profileId.data } : {}),
        ...(resolvedWslTarget.success && resolvedWslTarget.data
          ? { resolvedWslTarget: resolvedWslTarget.data }
          : {}),
      };
    }
  });

  ipcMain.handle(PlatformChannels.RequestSourceSettingsAttachment, (event, rawPayload: unknown) => {
    const sourceServerId =
      rawPayload &&
      typeof rawPayload === "object" &&
      "sourceServerId" in rawPayload &&
      typeof rawPayload.sourceServerId === "string"
        ? rawPayload.sourceServerId.trim()
        : "";
    if (!sourceServerId) throw new Error("sourceServerId is required");
    if (!options.attachSourceSettings) {
      throw new Error("Source settings attachment is unavailable");
    }
    return options.attachSourceSettings(event.sender, sourceServerId);
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // 连接建立前没有 sessionId，renderer 之前无法精准通知 main 取消正在进行的连接。
      // 现在优先按 requestId 精确取消当前弹窗发起的连接，避免误伤同窗口其他并发连接。
      // 若 requestId 缺失则回退到按窗口取消，兼容旧调用端。
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    async (event, rawPayload: unknown): Promise<BindRemoteWorkspaceSessionContextIpcResult> => {
      try {
        if (!rawPayload || typeof rawPayload !== "object") {
          throw new Error("远程 workspace context payload 无效");
        }
        const payload = rawPayload as {
          remoteSessionId?: unknown;
          workspacePath?: unknown;
          workspaceIdentity?: unknown;
          workspacePurpose?: unknown;
        };
        const remoteSessionId =
          typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
        const workspacePath =
          typeof payload.workspacePath === "string" ? payload.workspacePath : "";
        const workspaceIdentity =
          typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
        const workspacePurpose =
          payload.workspacePurpose === "project" || payload.workspacePurpose === "conversation"
            ? payload.workspacePurpose
            : undefined;
        if (!remoteSessionId || !workspacePath.trim()) {
          throw new Error("远程 workspace context 缺少 sessionId 或 workspacePath");
        }
        const result = await options.bindRemoteWorkspaceSessionContext(
          remoteSessionId,
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspacePurpose ? { workspacePurpose } : {}),
          },
          event.sender.id,
        );
        return { success: true, result };
      } catch (error) {
        return toBindIpcFailure(error);
      }
    },
  );

  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  ipcMain.handle(PlatformChannels.IsDockerAvailable, async () => {
    try {
      return await options.isDockerDaemonAvailable();
    } catch (error) {
      options.logger.warn("[is-docker-available] detect failed:", error);
      return false;
    }
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListDockerContainers, async () => {
    try {
      return await options.listAvailableDockerContainers();
    } catch (error) {
      options.logger.warn("[list-docker-containers] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // Error 对象直接落盘会被序列化成 `{}`，SSH config 解析失败时无法定位具体 pattern。
      // 显式展开错误字段，保留 UI 返回空列表的兼容行为，同时让日志能看到根因。
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
