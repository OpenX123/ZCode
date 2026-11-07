// createSession 的后台准备（docs/desktop/external-agent-engines-spec.md P01–P03）：
// connecting 写入后即返回，握手结果只经 engineConfigState 投影，关闭后迟到结果丢弃。
import { expect, test, vi } from "vitest";
import {
  createSessionId,
  ExternalEngineConnectionError,
  SessionEventType,
  type ExternalEnginePort,
  type ExternalEngineSessionInput,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const options = [
  { id: "mode", name: "Mode", currentValue: "safe", options: [{ value: "safe", name: "Safe" }] },
];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createRuntime(prepareSession: ExternalEnginePort["prepareSession"]) {
  const sessionId = createSessionId();
  const eventStore = createTestSessionEventStore();
  const port = {
    prepareSession: vi.fn(prepareSession),
    runTurn: vi.fn<ExternalEnginePort["runTurn"]>(),
    setConfigOption: vi.fn<ExternalEnginePort["setConfigOption"]>(),
    closeSession: vi.fn(async () => {}),
  };
  const runtime = new AgentRuntime(
    sessionId,
    { engine: "claude-code", workingDirectory: "/workspace" },
    { eventStore, externalEnginePort: port },
  );
  const states = async () =>
    (await eventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.ExternalEngineConfigUpdated)
      .map((event) => (event.payload as { engineConfigState?: string }).engineConfigState);
  return { runtime, port, states };
}

test("connecting 写入后即返回，握手在后台完成并发布 ready，不提交 prompt", async () => {
  const handshake = deferred();
  let captured: ExternalEngineSessionInput | undefined;
  const { runtime, port, states } = createRuntime(async (input) => {
    captured = input;
    await handshake.promise;
    await input.onConfigOptions(options);
  });
  await runtime.startExternalEngineSessionPreparation({ connectionProfileId: "gateway-a" });
  expect(runtime.getEngineConfigState()).toBe("connecting");
  expect(await states()).toEqual(["connecting"]);
  await vi.waitFor(() => expect(port.prepareSession).toHaveBeenCalledOnce());
  expect(captured?.connectionProfileId).toBe("gateway-a");
  // 后台准备期间的显式重试并入同一次握手（single-flight）。
  const joined = runtime.prepareExternalEngineSession();
  handshake.resolve();
  await joined;
  expect(port.prepareSession).toHaveBeenCalledOnce();
  expect(runtime.getEngineConfigState()).toBe("ready");
  expect(runtime.getEngineConfigOptions()).toEqual(options);
  expect(port.runTurn).not.toHaveBeenCalled();
  await runtime.closeBrowserSession();
});

test("后台握手失败只发布 error 与诊断，不抛给调用方，之后可经既有入口重试", async () => {
  let attempt = 0;
  const { runtime, port } = createRuntime(async (input) => {
    attempt += 1;
    if (attempt === 1)
      throw new ExternalEngineConnectionError({ code: "authentication", method: "session/new" });
    await input.onConfigOptions(options);
  });
  await expect(runtime.startExternalEngineSessionPreparation()).resolves.toBeUndefined();
  await vi.waitFor(() => expect(runtime.getEngineConfigState()).toBe("error"));
  expect(runtime.getEngineConfigError()).toMatchObject({
    code: "authentication",
    method: "session/new",
  });
  await runtime.prepareExternalEngineSession();
  expect(runtime.getEngineConfigState()).toBe("ready");
  expect(port.prepareSession).toHaveBeenCalledTimes(2);
  await runtime.closeBrowserSession();
});

test("握手中关闭 Runtime：中止后台准备，迟到的配置与错误都不再发布", async () => {
  const handshake = deferred();
  let captured: ExternalEngineSessionInput | undefined;
  const { runtime, port, states } = createRuntime(async (input) => {
    captured = input;
    await handshake.promise;
  });
  await runtime.startExternalEngineSessionPreparation();
  await vi.waitFor(() => expect(captured).toBeDefined());
  await runtime.closeBrowserSession();
  expect(port.closeSession).toHaveBeenCalledOnce();
  await captured!.onConfigOptions(options);
  handshake.reject(new ExternalEngineConnectionError({ code: "transport" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await states()).toEqual(["connecting"]);
  expect(runtime.getEngineConfigOptions()).toEqual([]);
});
