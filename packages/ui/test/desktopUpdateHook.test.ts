// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopUpdates } from "../src/hooks/desktop-updates/index.js";
import { DesktopUpdateButton } from "../src/desktop-updates/DesktopUpdateButton.js";

const mocks = vi.hoisted(() => ({ platform: {} as IPlatformService, toast: vi.fn() }));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => mocks.platform }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createPlatform() {
  let emit!: (state: UpdateStatePayload) => void;
  const checkForUpdates = vi.fn<NonNullable<IPlatformService["checkForUpdates"]>>(async () => ({
    kind: "up-to-date" as const,
    currentVersion: "1.0.0",
  }));
  const downloadUpdate = vi.fn(async () => ({ kind: "downloading" as const, version: "1.0.1" }));
  const installUpdate = vi.fn(async () => ({ kind: "ready" as const, version: "1.0.1" }));
  const onUpdateState = vi.fn((listener: typeof emit) => {
    emit = listener;
    return vi.fn();
  });
  mocks.platform = {
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    onUpdateState,
  } as unknown as IPlatformService;
  return {
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    onUpdateState,
    emit: (state: UpdateStatePayload) => emit(state),
  };
}

describe("桌面更新 hook", () => {
  it("侧栏隐藏未知版本的检查失败，保留已知版本的下载失败重试", () => {
    const platform = createPlatform();
    render(createElement(DesktopUpdateButton));
    act(() => platform.emit({ kind: "error", enabled: true, message: "HTTP 404" }));
    expect(screen.queryByTestId("desktop-update-action")).toBeNull();
    act(() =>
      platform.emit({
        kind: "error",
        enabled: true,
        message: "checksum mismatch",
        version: "1.0.1",
      }),
    );
    expect(screen.getByTestId("desktop-update-action")).toBeTruthy();
    expect(screen.getByTestId("desktop-update-status").textContent).toBe("checksum mismatch");
  });

  it("手动检查失败仍显示即时提示", async () => {
    const platform = createPlatform();
    platform.checkForUpdates.mockResolvedValueOnce({ kind: "error", message: "HTTP 404" });
    const { result } = renderHook(() => useDesktopUpdates());
    await act(() => result.current.check());
    expect(mocks.toast).toHaveBeenCalledWith(
      "desktopUpdate.error",
      expect.objectContaining({ variant: "warning" }),
    );
  });
  it("Web 不订阅状态，不执行检查", async () => {
    const platform = createPlatform();
    const { result } = renderHook(() => useDesktopUpdates(false));
    expect(result.current.supported).toBe(false);
    await act(() => result.current.check());
    expect(platform.onUpdateState).not.toHaveBeenCalled();
    expect(platform.checkForUpdates).not.toHaveBeenCalled();
  });
  it("按状态调用下载、错误重试和重新打开安装器", async () => {
    const platform = createPlatform();
    const { result } = renderHook(() => useDesktopUpdates());
    act(() => platform.emit({ kind: "update-available", enabled: true, version: "1.0.1" }));
    await act(() => result.current.activate());
    expect(platform.downloadUpdate).toHaveBeenCalledTimes(1);
    act(() => platform.emit({ kind: "download-progress", enabled: true, progress: "30" }));
    expect(result.current.busy).toBe(true);
    await act(() => result.current.activate());
    expect(platform.downloadUpdate).toHaveBeenCalledTimes(1);
    act(() =>
      platform.emit({ kind: "error", enabled: true, version: "1.0.1", message: "checksum" }),
    );
    await act(() => result.current.activate());
    expect(platform.downloadUpdate).toHaveBeenCalledTimes(2);
    act(() => platform.emit({ kind: "update-downloaded", enabled: true, version: "1.0.1" }));
    await act(() => result.current.activate());
    expect(platform.installUpdate).toHaveBeenCalledTimes(1);
  });
  it("未知目标的失败重试检查，最新版本提供 toast，不虚构可用版本", async () => {
    const platform = createPlatform();
    const { result } = renderHook(() => useDesktopUpdates());
    act(() => platform.emit({ kind: "error", enabled: true, message: "network" }));
    await act(() => result.current.activate());
    expect(platform.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("desktopUpdate.up-to-date", expect.any(Object));
    expect(result.current.state?.kind).toBe("error");
  });
});
