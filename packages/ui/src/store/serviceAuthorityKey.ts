const serviceAuthorityIds = new WeakMap<object, number>();
let nextServiceAuthorityId = 1;

// Bug 原因：同路径/identity 可以同时存在于 Controller 与多个 Source；只按路径分桶会让
// in-flight Promise 跨 RPC authority 复用。服务实例是 renderer 内最小、稳定的 authority 边界。
export function getServiceAuthorityId(service: object): number {
  const existing = serviceAuthorityIds.get(service);
  if (existing !== undefined) return existing;
  const created = nextServiceAuthorityId++;
  serviceAuthorityIds.set(service, created);
  return created;
}

export interface SharedServiceRead<TInput, TValue, TEvent> {
  /** fresh：显式重读，不读缓存也不复用已有在途请求；其结果仍可被之后的普通读取合并。 */
  read(input: TInput, options?: { fresh?: boolean }): Promise<TValue>;
  /** 上游变化事件；回调触发前读取器已作废缓存与在途请求，回调内的重读按键合并为一次。 */
  onDidChange(listener: (event: TEvent) => void): { dispose(): void };
}

/**
 * 按服务实例共享的只读结果（docs/desktop/engine-performance-1.1-spec.md「窗口级只读数据共享」）。
 *
 * 修复原因（2026-11-08 本机扫描 P5）：每个 SessionPane（含隐藏 Tab）各自读窗口级数据，窗口打开时
 * getBotStates 12 次、model-selection getView 27 次、getConnectionProfiles 9 次，且每次变化事件
 * 各实例各自重读。调用方按服务实例（即 RPC authority，见上方 getServiceAuthorityId）各持一个本对象：
 * - 同键并发读取合并为一次请求；
 * - 只在有订阅者期间缓存成功结果（期间能收到变化事件，缓存可信）；最后一个订阅者离开即退订并清空，
 *   失败不缓存；
 * - 上游事件只订阅一次；事件先作废缓存与在途请求（epoch+1，旧请求结果仍交给原调用者，但不写缓存、
 *   不被新读取复用），再通知订阅者。
 * 服务端事实仍只在 Host；这里只是读取合并，不另存第二份可写状态。
 */
export function createSharedServiceRead<TInput, TValue, TEvent>(source: {
  keyOf(input: TInput): string;
  fetch(input: TInput): Promise<TValue>;
  /** 返回 undefined 表示上游没有变化事件：此时只合并在途请求，从不缓存。 */
  subscribe(onEvent: (event: TEvent) => void): { dispose(): void } | undefined;
  /** 事件负载本身就是某个键的最新值时返回它，读取器直接写入缓存，订阅者无需再读。 */
  valueOfEvent?(event: TEvent): { key: string; value: TValue } | undefined;
}): SharedServiceRead<TInput, TValue, TEvent> {
  const listeners = new Set<(event: TEvent) => void>();
  const cache = new Map<string, TValue>();
  const inFlight = new Map<string, Promise<TValue>>();
  let active = false;
  let upstream: { dispose(): void } | undefined;
  let epoch = 0;
  const invalidate = () => {
    epoch += 1;
    cache.clear();
    inFlight.clear();
  };
  return {
    read(input, options) {
      const key = source.keyOf(input);
      if (!options?.fresh) {
        if (cache.has(key)) return Promise.resolve(cache.get(key) as TValue);
        const pending = inFlight.get(key);
        if (pending) return pending;
      }
      const requestEpoch = epoch;
      const cacheable = active && upstream !== undefined;
      const release = () => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      };
      const request: Promise<TValue> = source.fetch(input).then(
        (value) => {
          release();
          if (cacheable && requestEpoch === epoch) cache.set(key, value);
          return value;
        },
        (error: unknown) => {
          release();
          throw error;
        },
      );
      inFlight.set(key, request);
      return request;
    },
    onDidChange(listener) {
      listeners.add(listener);
      if (!active) {
        // 订阅前发出的读取可能早于本次订阅之前的变化，不能被复用或写入缓存。
        invalidate();
        active = true;
        upstream = source.subscribe((event) => {
          invalidate();
          const latest = source.valueOfEvent?.(event);
          if (latest) cache.set(latest.key, latest.value);
          for (const current of listeners) current(event);
        });
      }
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
          if (listeners.size > 0 || !active) return;
          // 退订后收不到变化事件，缓存与在途请求都不再可信，下次挂载重新读取。
          active = false;
          const subscription = upstream;
          upstream = undefined;
          invalidate();
          subscription?.dispose();
        },
      };
    },
  };
}
