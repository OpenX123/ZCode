/**
 * 会话 MCP lease 的闲置回收计时（规则见 docs/desktop/engine-performance-1.1-spec.md §1）。
 *
 * 修复原因：常驻会话的每会话 MCP / 插件宿主进程过去永不退出（本机 1.0.5 实测 61 个
 * `YCode.exe … __zcode-plugin-host` 进程、约 4.0GB RSS，部分已运行 3 天）。已连接的 server 在
 * 没有在途请求、也没有工具调用持续一个闲置窗口后由所属 lease 关闭，回到"待首次使用"，工具仍按
 * 清单缓存保留，下一次调用经同一首次启动路径重新连接。
 *
 * 模块内部实现：只拥有计时与在途计数；是否可回收与回收动作由 lease 决定。计时器全部 unref，
 * 并在 server 释放或 lease 关闭时清除，不会在会话关闭后遗留。
 */
export class LeaseIdleReclaimer {
  private readonly inflight = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly idleMs: number,
    private readonly onIdle: (serverName: string, isStillIdle: () => boolean) => void,
  ) {}

  /** 开始一次对该 server 的使用；返回的函数在使用结束时调用（重复调用无效）。 */
  begin(serverName: string): () => void {
    this.cancel(serverName);
    this.inflight.set(serverName, (this.inflight.get(serverName) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.inflight.get(serverName) ?? 1) - 1;
      if (remaining > 0) {
        this.inflight.set(serverName, remaining);
        return;
      }
      this.inflight.delete(serverName);
      this.arm(serverName);
    };
  }

  /** 从现在起重新计时；有在途使用、已关闭或未启用时不计时。 */
  arm(serverName: string): void {
    if (this.closed || this.idleMs <= 0 || this.isBusy(serverName)) return;
    this.cancel(serverName);
    const timer = setTimeout(() => {
      this.timers.delete(serverName);
      if (this.closed || this.isBusy(serverName)) return;
      // 回收方会跨 await 再确认；期间出现新使用或新计时都说明已不再闲置。
      this.onIdle(
        serverName,
        () => !this.closed && !this.isBusy(serverName) && !this.timers.has(serverName),
      );
    }, this.idleMs);
    timer.unref?.();
    this.timers.set(serverName, timer);
  }

  cancel(serverName: string): void {
    const timer = this.timers.get(serverName);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(serverName);
  }

  /** lease 关闭：清除全部计时器，之后不再计时。 */
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private isBusy(serverName: string): boolean {
    return (this.inflight.get(serverName) ?? 0) > 0;
  }
}
