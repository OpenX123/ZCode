import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { createDesktopUpdateProjection } from "../src/hooks/desktop-updates/projection.js";

describe("Main 更新状态共享投影", () => {
  it("两个入口共享监听且迟到快照不能覆盖下载事件", async () => {
    let emit!: (state: UpdateStatePayload) => void;
    let resolve!: (state: UpdateStatePayload) => void;
    const dispose = vi.fn();
    const subscribe = vi.fn((listener: typeof emit) => {
      emit = listener;
      return dispose;
    });
    const platform = {
      onUpdateState: subscribe,
      getUpdateState: () =>
        new Promise<UpdateStatePayload>((done) => {
          resolve = done;
        }),
    } as IPlatformService;
    const projection = createDesktopUpdateProjection(platform);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = projection.subscribe(first);
    const stopSecond = projection.subscribe(second);
    expect(subscribe).toHaveBeenCalledTimes(1);
    emit({ kind: "download-progress", enabled: true, progress: "42" });
    resolve({ kind: "idle", enabled: true });
    await Promise.resolve();
    expect(projection.getSnapshot()?.kind).toBe("download-progress");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(dispose).not.toHaveBeenCalled();
    stopSecond();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("释放后丢弃旧快照，新订阅读取新的快照", async () => {
    const resolvers: Array<(state: UpdateStatePayload) => void> = [];
    const platform = {
      onUpdateState: () => () => {},
      getUpdateState: () => new Promise<UpdateStatePayload>((resolve) => resolvers.push(resolve)),
    } as IPlatformService;
    const projection = createDesktopUpdateProjection(platform);
    const stop = projection.subscribe(() => {});
    stop();
    const stopNew = projection.subscribe(() => {});
    resolvers[1]!({ kind: "update-available", enabled: true, version: "1.0.1" });
    await Promise.resolve();
    resolvers[0]!({ kind: "idle", enabled: true });
    await Promise.resolve();
    expect(projection.getSnapshot()?.kind).toBe("update-available");
    stopNew();
  });
  it("缺少可选平台接口时可安全订阅与释放", () => {
    const projection = createDesktopUpdateProjection({} as IPlatformService);
    const stop = projection.subscribe(() => {});
    expect(projection.getSnapshot()).toBeNull();
    stop();
  });
});
