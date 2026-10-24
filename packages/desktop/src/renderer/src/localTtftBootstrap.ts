import { LocalTtftObserver, setLocalTtftObserver } from "@zcode/ui";

/** 首输出计时只写本地 debug 日志，不经过 IPC 或网络导出。 */
export function initializeDesktopLocalTtft(): () => void {
  const observer = new LocalTtftObserver(
    undefined,
    undefined,
    undefined,
    () => document.visibilityState === "visible" && document.hasFocus(),
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
