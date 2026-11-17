import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostMessageTypes,
  HostResponseTypes,
  InternalChannels,
  PlatformChannels,
} from "@zcode/shared";
import {
  assertSSHReconnectOrder,
  installSSHReconnectObservation,
  readSSHReconnectObservation,
  restoreSSHReconnectObservation,
  type SSHReconnectEvent,
} from "./e2e/helpers/ssh-reconnect-observation.js";

type ObservedEvent = SSHReconnectEvent & { reason?: string };
const identity = "remote:server:synthetic:/workspace-a";
const event = (
  sequence: number,
  kind: string,
  detail: Partial<ObservedEvent> = {},
): ObservedEvent => ({ sequence, observedAt: "2026-11-17T00:00:00.000Z", kind, ...detail });

function trace(closed = true): ObservedEvent[] {
  // R98 的脱敏序号保留；seq27 的 closed 是本测试受控输入，绝非回填原 run 的失联原因。
  const events = [
    event(10, "renderer-port", {
      sessionId: "old-a",
      attachmentId: "old-port-a",
      workspaceIdentity: identity,
      webContentsId: 7,
    }),
    event(30, "source-reconnected", {
      previousSessionId: "old-a",
      sessionId: "new-a",
      workspaceIdentity: identity,
      generation: 3,
    }),
    event(31, "host-attach", {
      sessionId: "new-a",
      attachmentId: "new-port-a",
      workspaceIdentity: identity,
    }),
    event(32, "renderer-port", {
      sessionId: "new-a",
      attachmentId: "new-port-a",
      workspaceIdentity: identity,
      webContentsId: 7,
    }),
    event(36, "renderer-ack", {
      sessionId: "new-a",
      attachmentId: "new-port-a",
      webContentsId: 7,
    }),
    event(closed ? 28 : 37, "host-detach", { attachmentId: "old-port-a" }),
    event(closed ? 37 : 38, "main-promoted", { sessionId: "new-a" }),
    event(closed ? 38 : 39, "renderer-notified", {
      previousSessionId: "old-a",
      sessionId: "new-a",
      workspaceIdentity: identity,
      webContentsId: 7,
    }),
  ];
  if (closed)
    events.push(event(27, "source-closed", { sessionId: "old-a", reason: "connection-closed" }));
  return events.sort((a, b) => a.sequence - b.sequence);
}

const assertTrace = (events: ObservedEvent[]) =>
  assertSSHReconnectOrder(events, "old-a", "new-a", identity);
const change = (events: ObservedEvent[], kind: string, detail: Partial<ObservedEvent>) => {
  Object.assign(events.find((entry) => entry.kind === kind)!, detail);
};

beforeEach(() => vi.stubGlobal("expect", expect));
afterEach(() => vi.unstubAllGlobals());

describe("真实重连顺序 export 的两条既有分支", () => {
  it("精确旧 session 失联后实际拆旧，再经历完整新 Source/ACK/promotion/通知", () => {
    expect(assertTrace(trace())).toEqual({
      previousSessionId: "old-a",
      sessionId: "new-a",
      previousAttachmentId: "old-port-a",
      attachmentId: "new-port-a",
      workspaceIdentity: identity,
      webContentsId: 7,
      generation: 3,
      branch: "connection-closed",
      previousPortSequence: 10,
      closedSequence: 27,
      sourceSequence: 30,
      attachedSequence: 31,
      portSequence: 32,
      ackSequence: 36,
      detachedSequence: 28,
      promotedSequence: 37,
      notifiedSequence: 38,
    });
  });

  it("仍有效旧 port 在精确新 ACK 后实际 Detach，再 promotion 和通知", () => {
    expect(assertTrace(trace(false))).toMatchObject({
      branch: "live-attachment",
      previousPortSequence: 10,
      sourceSequence: 30,
      ackSequence: 36,
      detachedSequence: 37,
      promotedSequence: 38,
      notifiedSequence: 39,
    });
  });

  it.each([true, false])(
    "合法首次拆旧后的同旧 ID 幂等 Detach 不误认新 attachment，closed=%s",
    (closed) => {
      const events = trace(closed);
      events.push(event(41, "host-detach", { attachmentId: "old-port-a" }));
      expect(assertTrace(events)).toMatchObject({
        branch: closed ? "connection-closed" : "live-attachment",
        attachmentId: "new-port-a",
        detachedSequence: closed ? 28 : 37,
      });
    },
  );

  const invalid: Array<{
    name: string;
    live?: boolean;
    mutate(events: ObservedEvent[]): void;
  }> = [
    {
      name: "提前拆旧但缺 closed",
      mutate: (events) => change(events, "source-closed", { kind: "unrelated" }),
    },
    {
      name: "closed 属于其他旧 session",
      mutate: (events) => change(events, "source-closed", { sessionId: "old-b" }),
    },
    {
      name: "disposed 不能冒认 connection-closed",
      mutate: (events) => change(events, "source-closed", { reason: "disposed" }),
    },
    {
      name: "closed 早于当前旧 port",
      mutate: (events) => change(events, "source-closed", { sequence: 9 }),
    },
    {
      name: "closed 晚于新 Source",
      mutate: (events) => change(events, "source-closed", { sequence: 33 }),
    },
    {
      name: "Detach 早于 closed",
      mutate: (events) => change(events, "host-detach", { sequence: 26 }),
    },
    {
      name: "失联 Detach 晚于新 Source",
      mutate: (events) => change(events, "host-detach", { sequence: 33 }),
    },
    {
      name: "已失联却退回 ACK 后拆旧分支",
      mutate: (events) => change(events, "host-detach", { sequence: 40 }),
    },
    {
      name: "遗漏实际 Detach",
      mutate: (events) => change(events, "host-detach", { kind: "unrelated" }),
    },
    {
      name: "拆除其他 attachment",
      mutate: (events) => change(events, "host-detach", { attachmentId: "other-port" }),
    },
    {
      name: "旧 port identity 不同",
      mutate: (events) => change(events, "renderer-port", { workspaceIdentity: "other" }),
    },
    {
      name: "新 Source identity 不同",
      mutate: (events) => change(events, "source-reconnected", { workspaceIdentity: "other" }),
    },
    {
      name: "新 Source generation 未换代",
      mutate: (events) => change(events, "source-reconnected", { generation: 1 }),
    },
    {
      name: "新 Source generation 非整数",
      mutate: (events) => change(events, "source-reconnected", { generation: 2.5 }),
    },
    {
      name: "新 Source generation 非有限值",
      mutate: (events) => change(events, "source-reconnected", { generation: Infinity }),
    },
    {
      name: "Source 的 previous session 不符",
      mutate: (events) => change(events, "source-reconnected", { previousSessionId: "other" }),
    },
    {
      name: "Host attach identity 不符",
      mutate: (events) => change(events, "host-attach", { workspaceIdentity: "other" }),
    },
    {
      name: "新 attach 复用旧 attachment",
      mutate: (events) => change(events, "host-attach", { attachmentId: "old-port-a" }),
    },
    {
      name: "新 port identity 不符",
      mutate: (events) => {
        events.find(
          (entry) => entry.kind === "renderer-port" && entry.sessionId === "new-a",
        )!.workspaceIdentity = "other";
      },
    },
    {
      name: "新 port 窗口不同",
      mutate: (events) => {
        events.find(
          (entry) => entry.kind === "renderer-port" && entry.sessionId === "new-a",
        )!.webContentsId = 8;
      },
    },
    {
      name: "新 ACK 来自错误窗口",
      mutate: (events) => change(events, "renderer-ack", { webContentsId: 8 }),
    },
    {
      name: "旧 session 的迟到 ACK",
      mutate: (events) => change(events, "renderer-ack", { sessionId: "old-a" }),
    },
    {
      name: "新 ACK 的 attachment 不符",
      mutate: (events) => change(events, "renderer-ack", { attachmentId: "old-port-a" }),
    },
    {
      name: "ACK 在 port 交付前",
      mutate: (events) => {
        change(events, "renderer-ack", { sequence: 33 });
        events.find(
          (entry) => entry.kind === "renderer-port" && entry.sessionId === "new-a",
        )!.sequence = 34;
      },
    },
    {
      name: "promotion 早于新 ACK",
      mutate: (events) => change(events, "main-promoted", { sequence: 35 }),
    },
    {
      name: "通知早于 promotion",
      mutate: (events) => change(events, "renderer-notified", { sequence: 35 }),
    },
    {
      name: "通知的旧 session 不符",
      mutate: (events) => change(events, "renderer-notified", { previousSessionId: "other" }),
    },
    {
      name: "通知的 identity 不符",
      mutate: (events) => change(events, "renderer-notified", { workspaceIdentity: "other" }),
    },
    {
      name: "通知来自错误窗口",
      mutate: (events) => change(events, "renderer-notified", { webContentsId: 8 }),
    },
    {
      name: "有效旧 port 无因提前拆除",
      live: true,
      mutate: (events) => change(events, "host-detach", { sequence: 28 }),
    },
    {
      name: "有效旧 port 在 promotion 后拆除",
      live: true,
      mutate: (events) => change(events, "host-detach", { sequence: 40 }),
    },
    {
      name: "后补 Detach 不掩盖无因提前拆除",
      live: true,
      mutate: (events) => {
        events.push(event(28, "host-detach", { attachmentId: "old-port-a" }));
      },
    },
  ];
  it.each(invalid)("拒绝$name", ({ live, mutate }) => {
    const events = trace(!live);
    mutate(events);
    events.sort((a, b) => a.sequence - b.sequence);
    expect(() => assertTrace(events)).toThrow();
  });
});

function sandbox() {
  // 子类仍执行 Node 的真实 emit，只隔离被 observer 包装的 prototype，避免污染 Vitest 的全局 EventEmitter。
  class OwnedEmitter extends EventEmitter {}
  const postCalls: unknown[][] = [];
  const postResult = { posted: true };
  const host = Object.assign(new OwnedEmitter(), {
    pid: 51,
    postMessage: function (...args: unknown[]) {
      postCalls.push([this, ...args]);
      return postResult;
    },
  });
  const contents = {
    id: 7,
    postMessage: function (...args: unknown[]) {
      return { receiver: this, args };
    },
    send: function (...args: unknown[]) {
      return { receiver: this, args };
    },
  };
  const ipcMain = new OwnedEmitter();
  const originalLog = (...args: unknown[]) => args.length;
  const context = createContext({
    console: { log: originalLog },
    process: {
      pid: 100,
      execPath: "/synthetic/desktop",
      resourcesPath: "/synthetic/resources",
      getBuiltinModule: (name: string) => {
        if (name !== "node:events") throw new Error("unexpected builtin");
        return { EventEmitter: OwnedEmitter };
      },
    },
  });
  const electron = { BrowserWindow: { getAllWindows: () => [{ webContents: contents }] }, ipcMain };
  vi.stubGlobal("browser", {
    electron: {
      execute: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        runInContext(`(${callback.toString()})`, context)(electron, ...args),
    },
  });
  const originals = {
    emit: OwnedEmitter.prototype.emit,
    post: host.postMessage,
    port: contents.postMessage,
    send: contents.send,
  };
  return {
    host,
    contents,
    context,
    ipcMain,
    OwnedEmitter,
    originals,
    postCalls,
    postResult,
    originalLog,
  };
}

describe("真实 install 回调的被动采集与恢复", () => {
  it("真实回调采集完整失联恢复链，Scoped port、ACK、日志和通知仍原样转发", async () => {
    const state = sandbox();
    const transfer = [{ port: "synthetic" }];
    const oldPort = { sessionId: "old-a", attachmentId: "old-port-a", workspaceIdentity: identity };
    const newPort = { sessionId: "new-a", attachmentId: "new-port-a", workspaceIdentity: identity };
    let portResult: { receiver: unknown; args: unknown[] } | undefined;
    state.host.on("message", (message: { type: string }) => {
      if (message.type === HostResponseTypes.RemoteWorkspaceClosed)
        state.host.postMessage({
          type: HostMessageTypes.DetachServicePort,
          attachmentId: "old-port-a",
        });
      if (message.type === HostResponseTypes.RemoteWorkspaceReconnected) {
        state.host.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            attachmentId: "new-port-a",
            scope: { kind: "remote", remoteSessionId: "new-a", workspaceIdentity: identity },
          },
          transfer,
        );
        portResult = state.contents.postMessage(
          InternalChannels.ScopedServicePort,
          newPort,
          transfer,
        );
      }
    });
    await installSSHReconnectObservation(51);
    try {
      state.contents.postMessage(InternalChannels.ScopedServicePort, oldPort, transfer);
      state.host.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceClosed,
        remoteSessionId: "old-a",
        reason: "connection-closed",
      });
      state.host.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceReconnected,
        previousRemoteSessionId: "old-a",
        descriptor: { remoteSessionId: "new-a", workspaceIdentity: identity, generation: 3 },
      });
      expect(portResult!.receiver).toBe(state.contents);
      expect(portResult!.args).toEqual([InternalChannels.ScopedServicePort, newPort, transfer]);
      expect(portResult!.args[1]).toBe(newPort);
      expect(portResult!.args[2]).toBe(transfer);
      state.ipcMain.emit(InternalChannels.ScopedServicePortReady, { sender: { id: 8 } }, newPort);
      state.ipcMain.emit(InternalChannels.ScopedServicePortReady, { sender: { id: 7 } }, newPort);
      const log = runInContext("console.log", state.context);
      expect(
        log(
          "[window-host-remote] renderer attachment ready, sessionId=new-a, reason=source-reconnected",
        ),
      ).toBe(1);
      const notice = {
        previousSessionId: "old-a",
        sessionId: "new-a",
        workspaceIdentity: identity,
      };
      const result = state.contents.send(PlatformChannels.RemoteSessionReconnected, notice);
      expect(result.receiver).toBe(state.contents);
      expect(result.args[1]).toBe(notice);
      const events = await readSSHReconnectObservation();
      expect(events.map((entry) => entry.kind)).toEqual([
        "renderer-port",
        "source-closed",
        "host-detach",
        "source-reconnected",
        "host-attach",
        "renderer-port",
        "renderer-ack",
        "main-promoted",
        "renderer-notified",
      ]);
      expect(assertTrace(events)).toMatchObject({
        branch: "connection-closed",
        closedSequence: 1,
        detachedSequence: 2,
        sourceSequence: 3,
        ackSequence: 6,
        promotedSequence: 7,
        notifiedSequence: 8,
      });
    } finally {
      await restoreSSHReconnectObservation();
    }
  });

  it("closed 在原 emit 触发 Detach 前记录，仅留白名单且参数和返回原样转发", async () => {
    const state = sandbox();
    const payload = {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "old-a",
      reason: "connection-closed",
      error: "fixture-private-field",
    };
    const marker = { unchanged: true };
    const transfer = [{ port: "synthetic" }];
    let observedArgs: unknown[] = [];
    let observedPostResult: unknown;
    state.host.on("message", (...args: unknown[]) => {
      observedArgs = args;
      observedPostResult = state.host.postMessage(
        { type: HostMessageTypes.DetachServicePort, attachmentId: "old-port-a" },
        transfer,
      );
    });
    await installSSHReconnectObservation(51);
    try {
      expect(state.host.emit("message", payload, marker)).toBe(true);
      expect(observedArgs[0]).toBe(payload);
      expect(observedArgs[1]).toBe(marker);
      expect(observedPostResult).toBe(state.postResult);
      expect(state.postCalls[0]).toEqual([
        state.host,
        { type: HostMessageTypes.DetachServicePort, attachmentId: "old-port-a" },
        transfer,
      ]);
      expect(state.postCalls[0]![2]).toBe(transfer);
      const events = await readSSHReconnectObservation();
      expect(events).toEqual([
        {
          sequence: 0,
          observedAt: expect.any(String),
          kind: "source-closed",
          sessionId: "old-a",
          reason: "connection-closed",
        },
        {
          sequence: 1,
          observedAt: expect.any(String),
          kind: "host-detach",
          attachmentId: "old-port-a",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("fixture-private-field");
    } finally {
      await restoreSSHReconnectObservation();
    }
    expect(state.OwnedEmitter.prototype.emit).toBe(state.originals.emit);
    expect(state.host.postMessage).toBe(state.originals.post);
    expect(state.contents.postMessage).toBe(state.originals.port);
    expect(state.contents.send).toBe(state.originals.send);
    expect(runInContext("console.log", state.context)).toBe(state.originalLog);
    expect(state.ipcMain.listenerCount(InternalChannels.ScopedServicePortReady)).toBe(0);
    expect(await readSSHReconnectObservation()).toEqual([]);
  });

  it("错误 Host 与非白名单 reason 不冒认 closed，但原事件仍传给真实 listener", async () => {
    const state = sandbox();
    const other = Object.assign(new state.OwnedEmitter(), { pid: 52 });
    let received = 0;
    state.host.on("message", () => received++);
    other.on("message", () => received++);
    await installSSHReconnectObservation(51);
    try {
      expect(
        other.emit("message", {
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: "old-a",
          reason: "connection-closed",
        }),
      ).toBe(true);
      expect(
        state.host.emit("message", {
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: "old-a",
          reason: "untrusted-free-text",
        }),
      ).toBe(true);
      expect(received).toBe(2);
      expect(await readSSHReconnectObservation()).toEqual([]);
    } finally {
      await restoreSSHReconnectObservation();
    }
  });

  it("原 listener 抛错仍传播同一错误，finally 恢复 emit、Host、WebContents 与 ACK listener", async () => {
    const state = sandbox();
    const failure = new Error("controlled-listener-failure");
    const existingAck = () => undefined;
    state.ipcMain.on(InternalChannels.ScopedServicePortReady, existingAck);
    state.host.on("message", () => {
      throw failure;
    });
    await installSSHReconnectObservation(51);
    try {
      expect(() =>
        state.host.emit("message", {
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: "old-a",
          reason: "connection-closed",
        }),
      ).toThrow(failure);
      expect(await readSSHReconnectObservation()).toMatchObject([
        { kind: "source-closed", sessionId: "old-a", reason: "connection-closed" },
      ]);
    } finally {
      await restoreSSHReconnectObservation();
    }
    expect(state.OwnedEmitter.prototype.emit).toBe(state.originals.emit);
    expect(state.host.postMessage).toBe(state.originals.post);
    expect(state.contents.postMessage).toBe(state.originals.port);
    expect(state.contents.send).toBe(state.originals.send);
    expect(state.ipcMain.listeners(InternalChannels.ScopedServicePortReady)).toEqual([existingAck]);
  });
});
