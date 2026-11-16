// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { DesktopZoomSettingsRow } from "@/settingsCodePreview.js";
import { logger } from "@/logger.js";

const labels: Record<string, string> = {
  "settings.desktopZoom": "Window zoom",
  "settings.desktopZoomDescription": "Scale the whole window.",
  "titleBar.menu.view.zoomIn": "Zoom in",
  "titleBar.menu.view.zoomOut": "Zoom out",
  "titleBar.menu.view.actualSize": "Actual size",
  "settings.desktopZoomLoadFailed": "Unable to read window zoom.",
  "common.retry": "Retry",
};
const platform = {
  executeDesktopCommand: vi.fn(async (_command: string) => {}),
  getDesktopZoomLevel: vi.fn(async () => ({ zoomLevel: 0 })),
  onDesktopZoomLevelChanged: vi.fn((_listener: (state: { zoomLevel: number }) => void) => vi.fn()),
};

vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => platform }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => labels[id] ?? id },
  }),
}));

beforeEach(() => {
  platform.executeDesktopCommand.mockReset().mockResolvedValue(undefined);
  platform.getDesktopZoomLevel.mockReset().mockResolvedValue({ zoomLevel: 0 });
  platform.onDesktopZoomLevelChanged.mockReset().mockImplementation(() => vi.fn());
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("桌面窗口整体缩放设置", () => {
  it("普通 Web 不显示桌面控件，也不查询窗口级别", () => {
    render(createElement(DesktopZoomSettingsRow, { isDesktop: false }));
    expect(screen.queryByText("Window zoom")).toBeNull();
    expect(platform.getDesktopZoomLevel).not.toHaveBeenCalled();
  });

  it("读取当前窗口级别并通过既有命令缩放，事件更新限值和重置状态", async () => {
    let publish: ((state: { zoomLevel: number }) => void) | undefined;
    platform.getDesktopZoomLevel.mockResolvedValueOnce({ zoomLevel: -3 });
    platform.onDesktopZoomLevelChanged.mockImplementationOnce((listener) => {
      publish = listener;
      return vi.fn();
    });
    render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(platform.executeDesktopCommand).toHaveBeenCalledWith(DesktopCommandIds.ZoomIn);
    publish?.({ zoomLevel: 5 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(platform.executeDesktopCommand).toHaveBeenCalledWith(DesktopCommandIds.ZoomOut);
    expect(platform.executeDesktopCommand).toHaveBeenCalledWith(DesktopCommandIds.ResetZoom);
    publish?.({ zoomLevel: 0 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actual size" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
  });

  it("同步缓存回放先展示，权威查询随后纠正不同的缓存", async () => {
    platform.onDesktopZoomLevelChanged.mockImplementationOnce((listener) => {
      listener({ zoomLevel: -3 });
      return vi.fn();
    });
    platform.getDesktopZoomLevel.mockResolvedValueOnce({ zoomLevel: 5 });
    render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false);
  });

  it("晚到初值不覆盖较新的事件，卸载后解除订阅", async () => {
    let resolveInitial: (state: { zoomLevel: number }) => void = () => {};
    const initial = new Promise<{ zoomLevel: number }>((resolve) => {
      resolveInitial = resolve;
    });
    platform.getDesktopZoomLevel.mockReturnValueOnce(initial);
    let publish: ((state: { zoomLevel: number }) => void) | undefined;
    const dispose = vi.fn();
    platform.onDesktopZoomLevelChanged.mockImplementationOnce((listener) => {
      listener({ zoomLevel: -3 });
      publish = listener;
      return dispose;
    });
    const view = render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    publish?.({ zoomLevel: 5 });
    resolveInitial({ zoomLevel: -3 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false);
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("读取失败但有同步缓存时保留限值并显示可重试提示", async () => {
    platform.onDesktopZoomLevelChanged.mockImplementationOnce((listener) => {
      listener({ zoomLevel: -3 });
      return vi.fn();
    });
    platform.getDesktopZoomLevel.mockRejectedValueOnce(new Error("ipc denied"));
    platform.getDesktopZoomLevel.mockResolvedValueOnce({ zoomLevel: 1 });
    render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to read window zoom.");
    expect(logger.warn).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Actual size" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(platform.getDesktopZoomLevel).toHaveBeenCalledTimes(2);
  });

  it("查询失败后新的窗口级别事件清除提示并更新限值", async () => {
    let publish: ((state: { zoomLevel: number }) => void) | undefined;
    platform.onDesktopZoomLevelChanged.mockImplementationOnce((listener) => {
      listener({ zoomLevel: -3 });
      publish = listener;
      return vi.fn();
    });
    platform.getDesktopZoomLevel.mockRejectedValueOnce(new Error("ipc denied"));
    render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    await screen.findByRole("alert");
    act(() => publish?.({ zoomLevel: 5 }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false);
  });

  it("无可信级别且读取失败时说明问题，重试查询恢复操作", async () => {
    platform.getDesktopZoomLevel.mockRejectedValueOnce(new Error("ipc denied"));
    platform.getDesktopZoomLevel.mockResolvedValueOnce({ zoomLevel: 1 });
    render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to read window zoom.");
    expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actual size" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(platform.getDesktopZoomLevel).toHaveBeenCalledTimes(2);
  });

  it("卸载后到达的读取失败不更新界面或记录为当前错误", async () => {
    let rejectInitial: (reason: Error) => void = () => {};
    platform.getDesktopZoomLevel.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectInitial = reject;
      }),
    );
    const view = render(createElement(DesktopZoomSettingsRow, { isDesktop: true }));
    view.unmount();
    rejectInitial(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
