import type { IPlatformService } from "@zcode/shared";
import { LocalTtftObserver, setLocalTtftObserver } from "@zcode/ui";

/**
 * 首输出明细只写本地 debug 日志；每次已下发命令的观测闭合时，另经平台日志通道写一条
 * info 摘要到本机桌面日志（docs/trace/local-ttft-diagnostics.md），不经过网络导出。
 */
export function initializeDesktopLocalTtft(
  platform?: Pick<IPlatformService, "writeLocalDiagnosticLog">,
): () => void {
  const observer = new LocalTtftObserver(
    undefined,
    undefined,
    undefined,
    () => document.visibilityState === "visible" && document.hasFocus(),
    platform?.writeLocalDiagnosticLog
      ? (summary) => platform.writeLocalDiagnosticLog?.("[local-perf] send summary", summary)
      : undefined,
  );
  observer.enabled = true;
  setLocalTtftObserver(observer);
  const sample = () => {
    observer.sampleClock();
    observer.expire();
  };
  const background = () => observer.background();
  const foreground = () => {
    if (document.visibilityState === "visible") observer.foreground();
  };
  const visibility = () => {
    if (document.visibilityState !== "visible") background();
    else foreground();
  };
  if (!document.hasFocus() || document.visibilityState !== "visible") background();
  window.addEventListener("blur", background);
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", visibility);
  const timer = setInterval(sample, 1000);
  return () => {
    observer.interrupt();
    clearInterval(timer);
    setLocalTtftObserver(undefined);
    window.removeEventListener("blur", background);
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", visibility);
  };
}
