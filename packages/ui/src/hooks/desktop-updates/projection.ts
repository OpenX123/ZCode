import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";

/** 一个平台共用一个订阅；先订阅事件，防止迟到的初始快照回退下载状态。 */
export function createDesktopUpdateProjection(platform: IPlatformService) {
  let state: UpdateStatePayload | null = null;
  let dispose: (() => void) | undefined;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (value: UpdateStatePayload) => {
    state = value;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const session = ++generation;
        let receivedEvent = false;
        dispose = platform.onUpdateState?.((value) => {
          receivedEvent = true;
          publish(value);
        });
        void platform
          .getUpdateState?.()
          .then((value) => {
            if (session === generation && !receivedEvent) publish(value);
          })
          .catch(() => {
            /* 后续事件或用户手动检查可恢复初始读取失败。 */
          });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation++;
          dispose?.();
          dispose = undefined;
        }
      };
    },
  };
}
