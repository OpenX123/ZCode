import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  networkCaptureControlSchema,
  zcodeProtocolMessageSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
} from "@zcode/shared";
import type { Logger } from "@zcode/contracts";
import { planProtocolDispatch, type ProtocolLaneKind } from "./transport-lanes.js";

type ZCodeProtocolOutgoingMessage =
  | ZCodeProtocolError
  | ZCodeProtocolNotification
  | ZCodeProtocolRequest
  | ZCodeProtocolResponse;

type ZCodeProtocolMessageHandler = (
  message: ZCodeProtocolMessage,
) => Promise<ZCodeProtocolOutgoingMessage | undefined>;

const PROTOCOL_EOF_DRAIN_MS = 100;
// 本地性能摘要只关心可感知的排队与慢请求；阈值以下不落日志，避免逐请求刷屏。
const REQUEST_QUEUE_WAIT_LOG_THRESHOLD_MS = 50;
const SLOW_REQUEST_LOG_THRESHOLD_MS = 500;
const TRANSPORT_LOG_MODULE = "bootstrap.zcode_protocol";

type RequestTimingLane = ProtocolLaneKind | "control" | "immediate";

/** 某条分道上最后入队的请求：后来者等 done，控制请求等 started。 */
interface ProtocolLaneTail {
  done: Promise<void>;
  started: Promise<void>;
}

interface ZCodeProtocolNdjsonConnectionOptions {
  signal?: AbortSignal;
  clearPostResponseMessages?: () => void;
  handleMessage: ZCodeProtocolMessageHandler;
  input: NodeJS.ReadableStream;
  logger?: Logger;
  /** 单调时钟，仅用于排队与耗时观测；测试可注入。 */
  now?: () => number;
  onTransportClosed?: (error: Error) => void;
  output: NodeJS.WritableStream;
  takePostResponseMessages?: (
    requestId: ZCodeProtocolRequestId,
  ) => readonly ZCodeProtocolOutgoingMessage[];
  takePostResponseBatch?: (requestId: ZCodeProtocolRequestId) => {
    readonly messages: readonly ZCodeProtocolOutgoingMessage[];
    commit(): boolean;
  } | null;
}

export class ZCodeProtocolNdjsonConnection {
  private buffer = "";
  /** 分道键 → 最后入队请求。分道空闲后删除，避免会话数增长时无界积累。 */
  private readonly lanes = new Map<string, ProtocolLaneTail>();
  /** 所有在途请求处理（分道、控制与收到即处理），EOF drain 等它们全部结束。 */
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private terminal = false;
  private transportCloseNotified = false;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ZCodeProtocolNdjsonConnectionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.closedPromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
  }

  start(): void {
    this.options.input.on("data", this.onData);
    this.options.input.once("end", this.onClose);
    this.options.input.once("close", this.onClose);
    this.options.input.on("error", this.onError);
    this.options.output.on("error", this.onError);
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.options.signal?.aborted) this.onAbort();
  }

  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  send(message: ZCodeProtocolOutgoingMessage): void {
    if (this.terminal) return;
    // 观测可丢弃，不能在 stdout 背压时无界积压或挤占业务协议输出。
    if (
      "method" in message &&
      message.method === zcodeProtocolNotifications.processNetworkRequests &&
      ((this.options.output as NodeJS.WritableStream & { writableLength?: number })
        .writableLength ?? 0) >=
        256 * 1024
    )
      return;
    try {
      this.options.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.terminal || this.draining) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  };

  private readonly onClose = (): void => {
    if (this.terminal || this.draining) return;
    const trailing = this.buffer.trim();
    if (trailing.length > 0) {
      this.dispatchLine(trailing);
      this.buffer = "";
    }
    this.draining = true;
    this.notifyTransportClosed(new Error("ZCode Protocol client connection closed"));
    // EOF 保留短请求半关闭响应，但挂起 handler 不能让进程永久保活。
    this.drainTimer = setTimeout(() => this.finish(), PROTOCOL_EOF_DRAIN_MS);
    // 分道后没有单条 processing 链可等：所有分道与收到即处理的在途请求都结束才算 drain 完成。
    void this.whenIdle().then(() => this.finish());
  };

  private async whenIdle(): Promise<void> {
    // 在途请求在 dispatchLine 中同步登记；EOF 后 onData 不再接单，集合只会缩小。
    while (this.inflight.size > 0) {
      await Promise.allSettled(this.inflight);
    }
  }

  private readonly onAbort = (): void => {
    this.notifyTransportClosed(new Error("ZCode Protocol runtime stopping"));
    this.finish();
  };

  private readonly onError = (error: Error): void => {
    this.notifyTransportClosed(error);
    this.fail(error);
  };

  private notifyTransportClosed(error: Error): void {
    if (this.transportCloseNotified) return;
    this.transportCloseNotified = true;
    this.options.onTransportClosed?.(error);
  }

  private finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.resolveClosed();
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.notifyTransportClosed(error);
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.rejectClosed(error);
  }

  private detachInput(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onClose);
    this.options.input.off("close", this.onClose);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    // 错误 listener 保留到流本身结束，吸收已经排入事件循环的迟到 stream error。
  }

  private dispatchLine(line: string): void {
    if (this.terminal) return;
    const message = this.decodeLine(line);
    if (!message) {
      return;
    }
    if (
      !("id" in message) &&
      "method" in message &&
      message.method === zcodeProtocolMethods.processNetworkCapture
    ) {
      // 启停是进程观测控制，不等待正在执行的生成任务，也不进入 CommandInbox。
      if (networkCaptureControlSchema.safeParse(message.params).success) {
        void this.handleMessage(message).catch(() => {
          /* 观测失败不关闭业务连接 */
        });
      }
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      // Agent 发出反向 request 前已同步登记 pending response。
      // 若 response 等待“最后一个排队请求开始”，后续普通请求会把等待点推到当前长请求之后，
      // 形成「当前请求等 response、response 等后续请求」的死锁。
      void this.handleMessage(message).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    const plan = planProtocolDispatch(message);
    const enqueuedAt = this.now();
    if (plan.kind === "immediate") {
      // Bugfix：插件详情与列表曾排在串行队列里，安装 A 下载期间打开详情卡在组件 loading，
      // 新建右侧标签页（新 store 首次加载 list/overview）卡在骨架屏。无会话纯读不依赖前序请求的
      // 执行结果，因此不排队，也不等任何分道的"已开始"屏障。
      this.track(this.runTimed(message, "immediate", enqueuedAt));
      return;
    }
    if (plan.kind === "control") {
      // 停止/取消控制必须等它前面的同道请求真正进入 handler、建立 abort controller，再越过该请求的
      // 异步执行；只延后一轮微任务会让控制请求提前成为空操作。只等到达时已入队的最后一个请求。
      const barriers = plan.laneKeys.map((key) => this.lanes.get(key)?.started);
      this.track(
        Promise.all(barriers).then(() => this.runTimed(message, "control", enqueuedAt)),
      );
      return;
    }
    this.enqueueInLanes(message, plan.laneKind, plan.laneKeys, enqueuedAt);
  }

  /**
   * 同一分道 FIFO：请求等这些分道上所有前序请求完成后开始。涉及多个分道的请求同时成为这些分道的
   * 队尾，因而与每个分道里前后的请求都保序。不同分道之间互不等待。
   */
  private enqueueInLanes(
    message: ZCodeProtocolMessage,
    laneKind: ProtocolLaneKind,
    laneKeys: readonly string[],
    enqueuedAt: number,
  ): void {
    const previous = laneKeys.map((key) => this.lanes.get(key)?.done);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const done = Promise.all(previous).then(() =>
      this.runTimed(message, laneKind, enqueuedAt, markStarted),
    );
    const tail: ProtocolLaneTail = { done, started };
    for (const key of laneKeys) this.lanes.set(key, tail);
    this.track(done);
    void done.then(() => {
      for (const key of laneKeys) {
        if (this.lanes.get(key) === tail) this.lanes.delete(key);
      }
    });
  }

  private track(work: Promise<void>): void {
    this.inflight.add(work);
    void work.then(() => this.inflight.delete(work));
  }

  /** 执行一条请求并记录排队/耗时观测；永不 reject，handler 失败按原语义终结连接。 */
  private async runTimed(
    message: ZCodeProtocolMessage,
    lane: RequestTimingLane,
    enqueuedAt: number,
    markStarted?: () => void,
  ): Promise<void> {
    const startedAt = this.now();
    const queueWaitMs = startedAt - enqueuedAt;
    const method = "method" in message ? message.method : undefined;
    if (queueWaitMs > REQUEST_QUEUE_WAIT_LOG_THRESHOLD_MS) {
      this.options.logger?.info("ZCode Protocol request waited in lane", {
        event: "zcode_protocol.request.queue_wait",
        lane,
        method,
        module: TRANSPORT_LOG_MODULE,
        status: "started",
        waitMs: Math.round(queueWaitMs),
      });
    }
    try {
      const handling = this.handleMessage(message);
      markStarted?.();
      await handling;
    } catch (error) {
      markStarted?.();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const durationMs = this.now() - startedAt;
    if (durationMs >= SLOW_REQUEST_LOG_THRESHOLD_MS) {
      this.options.logger?.info("ZCode Protocol request slow", {
        durationMs: Math.round(durationMs),
        event: "zcode_protocol.request.slow",
        lane,
        method,
        module: TRANSPORT_LOG_MODULE,
        queueWaitMs: Math.round(queueWaitMs),
        status: "completed",
      });
    }
  }

  private decodeLine(line: string): ZCodeProtocolMessage | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      this.options.logger?.warn("ZCode Protocol JSON parse failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.parse.failed",
        module: "bootstrap.zcode_protocol",
        status: "failed",
      });
      this.sendError("parse-error", -32700, "Parse error");
      return null;
    }

    const parsed = zcodeProtocolMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.sendError("invalid-message", -32600, "Invalid ZCode Protocol message", {
        issues: parsed.error.issues,
      });
      return null;
    }

    return parsed.data;
  }

  private async handleMessage(message: ZCodeProtocolMessage): Promise<void> {
    if (this.terminal) return;
    const response = await this.options.handleMessage(message);
    if (response) {
      // 确定性时序：先一次性 take 当前 request 的 outbox，再连续写 response
      // 与 notification。禁止 queueMicrotask/setTimeout 或依赖底层分包先后。
      const postResponseBatch =
        "id" in response && ("result" in response || "error" in response)
          ? (this.options.takePostResponseBatch?.(response.id) ?? {
              messages: this.options.takePostResponseMessages?.(response.id) ?? [],
              commit: () => true,
            })
          : { messages: [], commit: () => true };
      // output EPIPE 可能发生在 subscribe handler 在途期间。fail() 已清过
      // 当时的 outbox，但迟到 handler 仍可能新建 request entry；这里先 take 精确释放，
      // terminal 时不再写 response/initial，避免 close 后引用泄漏或继续写坏流。
      if (this.terminal) return;
      this.send(response);
      for (const postResponseMessage of postResponseBatch.messages) {
        this.send(postResponseMessage);
      }
      // 旧 outbox 在生成 logical frame 时已推进 publisher 水位。这里以
      // Writable.write() 未同步抛错作为“进入本 connection-owned queue”的 admission；
      // 后续异步 EPIPE 会终结整个 connection epoch，旧 subscription 不会在新管道复用。
      if (!this.terminal) postResponseBatch.commit();
    }
  }

  private sendError(id: string, code: number, message: string, data?: unknown): void {
    this.send({
      error: {
        code,
        data,
        message,
      },
      id,
    });
  }
}
