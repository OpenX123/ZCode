import type { UtilityProcess } from "electron";
import {
  HostMessageTypes,
  HostResponseTypes,
  InternalChannels,
  PlatformChannels,
} from "@zcode/shared";

export interface SSHReconnectEvent {
  sequence: number;
  observedAt: string;
  kind: string;
  sessionId?: string;
  previousSessionId?: string;
  attachmentId?: string;
  workspaceIdentity?: string;
  generation?: number;
  webContentsId?: number;
  reason?: "connection-closed" | "disposed" | "connect-cancelled";
}

type Observation = { events: SSHReconnectEvent[]; restore(): void };
declare global {
  var __sshReconnectObservation: Observation | undefined;
}

/** 只记录真实owner调用；所有参数、返回值、事件和原调用顺序均原样转发。 */
export async function installSSHReconnectObservation(hostPid: number) {
  return browser.electron.execute(
    (electron, expectedHostPid, channels) => {
      if (globalThis.__sshReconnectObservation)
        throw new Error("SSH reconnect observer already installed");
      const { EventEmitter } = process.getBuiltinModule("node:events");
      const originalEmit = EventEmitter.prototype.emit;
      const originalConsole = console.log;
      const originals = new Map<UtilityProcess, UtilityProcess["postMessage"]>();
      const events: SSHReconnectEvent[] = [];
      const record = (
        kind: string,
        detail: Omit<SSHReconnectEvent, "kind" | "sequence" | "observedAt">,
      ) =>
        events.push({
          sequence: events.length,
          observedAt: new Date().toISOString(),
          kind,
          ...detail,
        });
      const windows = electron.BrowserWindow.getAllWindows();
      if (windows.length !== 1) throw new Error("SSH observer requires one owned window");
      const contents = windows[0]!.webContents;
      const originalPost = contents.postMessage;
      const originalSend = contents.send;
      EventEmitter.prototype.emit = function (name, ...args: unknown[]) {
        const child = this as UtilityProcess;
        if (name === "message" && child.pid === expectedHostPid) {
          if (!originals.has(child)) {
            const post = child.postMessage;
            originals.set(child, post);
            child.postMessage = function (message, transfer) {
              const result = Reflect.apply(
                post,
                this,
                transfer === undefined ? [message] : [message, transfer],
              );
              if (message?.type === channels.attach && message.scope?.kind === "remote")
                record("host-attach", {
                  sessionId: message.scope.remoteSessionId,
                  attachmentId: message.attachmentId,
                  workspaceIdentity: message.scope.workspaceIdentity,
                });
              if (message?.type === channels.detach)
                record("host-detach", { attachmentId: message.attachmentId });
              return result;
            };
          }
          const message = args[0] as
            | {
                type?: string;
                remoteSessionId?: string;
                reason?: string;
                previousRemoteSessionId?: string;
                descriptor?: {
                  remoteSessionId: string;
                  workspaceIdentity?: string;
                  generation?: number;
                };
              }
            | undefined;
          // 失联在 Main 原 listener 内立即拆旧，必须先记真实 closed，不能由 Detach 的早晚反推原因。
          if (
            message?.type === channels.sourceClosed &&
            typeof message.remoteSessionId === "string" &&
            message.remoteSessionId.length > 0 &&
            (message.reason === "connection-closed" ||
              message.reason === "disposed" ||
              message.reason === "connect-cancelled")
          )
            record("source-closed", {
              sessionId: message.remoteSessionId,
              reason: message.reason,
            });
          if (message?.type === channels.sourceReconnected && message.descriptor)
            record("source-reconnected", {
              previousSessionId: message.previousRemoteSessionId,
              sessionId: message.descriptor.remoteSessionId,
              workspaceIdentity: message.descriptor.workspaceIdentity,
              generation: message.descriptor.generation,
            });
        }
        return Reflect.apply(originalEmit, this, [name, ...args]);
      };
      contents.postMessage = function (channel, message, transfer) {
        const result = Reflect.apply(
          originalPost,
          this,
          transfer === undefined ? [channel, message] : [channel, message, transfer],
        );
        if (channel === channels.port)
          record("renderer-port", {
            sessionId: message.sessionId,
            attachmentId: message.attachmentId,
            workspaceIdentity: message.workspaceIdentity,
            webContentsId: this.id,
          });
        return result;
      };
      contents.send = function (channel, ...args: unknown[]) {
        const result = Reflect.apply(originalSend, this, [channel, ...args]);
        if (channel === channels.notified) {
          const payload = args[0] as {
            sessionId: string;
            previousSessionId: string;
            workspaceIdentity?: string;
          };
          record("renderer-notified", {
            sessionId: payload.sessionId,
            previousSessionId: payload.previousSessionId,
            workspaceIdentity: payload.workspaceIdentity,
            webContentsId: this.id,
          });
        }
        return result;
      };
      const onAck = (
        event: { sender: { id: number } },
        payload: { sessionId: string; attachmentId: string },
      ) => {
        if (event.sender.id === contents.id)
          record("renderer-ack", {
            sessionId: payload.sessionId,
            attachmentId: payload.attachmentId,
            webContentsId: event.sender.id,
          });
      };
      electron.ipcMain.prependListener(channels.ack, onAck);
      console.log = function (...args: unknown[]) {
        const message = args.find(
          (arg): arg is string =>
            typeof arg === "string" &&
            arg.startsWith("[window-host-remote] renderer attachment ready, sessionId="),
        );
        if (message) {
          const match = /sessionId=([^,]+), reason=(.+)$/u.exec(message);
          if (match) record("main-promoted", { sessionId: match[1] });
        }
        return Reflect.apply(originalConsole, this, args);
      };
      globalThis.__sshReconnectObservation = {
        events,
        restore() {
          EventEmitter.prototype.emit = originalEmit;
          console.log = originalConsole;
          contents.postMessage = originalPost;
          contents.send = originalSend;
          electron.ipcMain.removeListener(channels.ack, onAck);
          for (const [child, post] of originals) child.postMessage = post;
          delete globalThis.__sshReconnectObservation;
        },
      };
      return {
        mainPid: process.pid,
        mainExecutable: process.execPath,
        resources: process.resourcesPath,
        hostPid: expectedHostPid,
        webContentsId: contents.id,
      };
    },
    hostPid,
    {
      attach: HostMessageTypes.AttachServicePort,
      detach: HostMessageTypes.DetachServicePort,
      sourceReconnected: HostResponseTypes.RemoteWorkspaceReconnected,
      sourceClosed: HostResponseTypes.RemoteWorkspaceClosed,
      port: InternalChannels.ScopedServicePort,
      ack: InternalChannels.ScopedServicePortReady,
      notified: PlatformChannels.RemoteSessionReconnected,
    },
  );
}

export async function readSSHReconnectObservation(): Promise<SSHReconnectEvent[]> {
  return browser.electron.execute(() => globalThis.__sshReconnectObservation?.events ?? []);
}

export async function restoreSSHReconnectObservation() {
  await browser.electron.execute(() => globalThis.__sshReconnectObservation?.restore());
}

/** 按同一Main的单调sequence关联真实Source、attachment及ACK，不用跨进程时钟推断顺序。 */
export function assertSSHReconnectOrder(
  events: SSHReconnectEvent[],
  previousSessionId: string,
  sessionId: string,
  workspaceIdentity: string,
) {
  const source = events.find(
    (event) =>
      event.kind === "source-reconnected" &&
      event.previousSessionId === previousSessionId &&
      event.sessionId === sessionId,
  );
  expect(source).toBeDefined();
  expect(sessionId).not.toBe(previousSessionId);
  expect(source!.workspaceIdentity).toBe(workspaceIdentity);
  expect(Number.isSafeInteger(source!.generation)).toBe(true);
  expect(source!.generation).toBeGreaterThan(1);
  const previous = events.findLast(
    (event) =>
      event.kind === "renderer-port" &&
      event.sessionId === previousSessionId &&
      event.sequence < source!.sequence,
  );
  expect(previous?.attachmentId).toBeTruthy();
  expect(previous!.workspaceIdentity).toBe(workspaceIdentity);
  expect(Number.isSafeInteger(previous!.webContentsId)).toBe(true);
  expect(previous!.webContentsId).toBeGreaterThan(0);
  const attached = events.find(
    (event) =>
      event.kind === "host-attach" &&
      event.sessionId === sessionId &&
      event.sequence > source!.sequence,
  );
  expect(attached?.attachmentId).toBeTruthy();
  expect(attached!.attachmentId).not.toBe(previous!.attachmentId);
  expect(attached!.workspaceIdentity).toBe(workspaceIdentity);
  const port = events.find(
    (event) =>
      event.kind === "renderer-port" &&
      event.sessionId === sessionId &&
      event.attachmentId === attached!.attachmentId &&
      event.sequence > attached!.sequence,
  );
  expect(port).toBeDefined();
  expect(port!.workspaceIdentity).toBe(workspaceIdentity);
  expect(port!.webContentsId).toBe(previous!.webContentsId);
  const ack = events.find(
    (event) =>
      event.kind === "renderer-ack" &&
      event.sessionId === sessionId &&
      event.attachmentId === attached!.attachmentId &&
      event.sequence > port!.sequence,
  );
  expect(ack).toBeDefined();
  expect(ack!.webContentsId).toBe(previous!.webContentsId);
  const closed = events.findLast(
    (event) =>
      event.kind === "source-closed" &&
      event.sessionId === previousSessionId &&
      event.reason === "connection-closed" &&
      event.sequence > previous!.sequence &&
      event.sequence < source!.sequence,
  );
  // 只取当前旧 port 后的第一次真实 Detach，防止后补请求掩盖无因提前拆除。
  const detached = events.find(
    (event) =>
      event.kind === "host-detach" &&
      event.attachmentId === previous!.attachmentId &&
      event.sequence > previous!.sequence,
  );
  expect(detached).toBeDefined();
  if (closed) {
    expect(detached!.sequence).toBeGreaterThan(closed.sequence);
    expect(detached!.sequence).toBeLessThan(source!.sequence);
  } else {
    expect(detached!.sequence).toBeGreaterThan(ack!.sequence);
  }
  const promoted = events.find(
    (event) =>
      event.kind === "main-promoted" &&
      event.sessionId === sessionId &&
      event.sequence > source!.sequence,
  );
  expect(promoted).toBeDefined();
  expect(promoted!.sequence).toBeGreaterThan(ack!.sequence);
  expect(promoted!.sequence).toBeGreaterThan(detached!.sequence);
  const notified = events.find(
    (event) =>
      event.kind === "renderer-notified" &&
      event.sessionId === sessionId &&
      event.previousSessionId === previousSessionId &&
      event.sequence > source!.sequence,
  );
  expect(notified).toBeDefined();
  expect(notified!.sequence).toBeGreaterThan(promoted!.sequence);
  expect(notified!.workspaceIdentity).toBe(workspaceIdentity);
  expect(notified!.webContentsId).toBe(previous!.webContentsId);
  return {
    previousSessionId,
    sessionId,
    previousAttachmentId: previous!.attachmentId,
    attachmentId: attached!.attachmentId,
    workspaceIdentity,
    webContentsId: previous!.webContentsId,
    generation: source!.generation,
    branch: closed ? "connection-closed" : "live-attachment",
    previousPortSequence: previous!.sequence,
    closedSequence: closed?.sequence,
    sourceSequence: source!.sequence,
    attachedSequence: attached!.sequence,
    portSequence: port!.sequence,
    ackSequence: ack!.sequence,
    detachedSequence: detached!.sequence,
    promotedSequence: promoted!.sequence,
    notifiedSequence: notified!.sequence,
  };
}
