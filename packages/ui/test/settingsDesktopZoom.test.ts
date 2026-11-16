// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { DesktopZoomSettingsRow } from "@/settingsCodePreview.js";

const labels: Record<string, string> = {
  "settings.desktopZoom": "Window zoom",
  "settings.desktopZoomDescription": "Scale the whole window.",
  "titleBar.menu.view.zoomIn": "Zoom in",
  "titleBar.menu.view.zoomOut": "Zoom out",
  "titleBar.menu.view.actualSize": "Actual size",
};
const platform = {
  executeDesktopCommand: vi.fn(async (_command: string) => {}),
  getDesktopZoomLevel: vi.fn(async () => ({ zoomLevel: 0 })),
  onDesktopZoomLevelChanged: vi.fn(
    (_listener: (state: { zoomLevel: number }) => void) => vi.fn(),
  ),
};

vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => platform }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => labels[id] ?? id },
  }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

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
      expect(
        screen
          .getByRole("button", { name: "Zoom out" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(platform.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.ZoomIn,
    );
    publish?.({ zoomLevel: 5 });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Zoom in" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(platform.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.ZoomOut,
    );
    expect(platform.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.ResetZoom,
    );
    publish?.({ zoomLevel: 0 });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Actual size" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
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
      publish = listener;
      return dispose;
    });
    const view = render(
      createElement(DesktopZoomSettingsRow, { isDesktop: true }),
    );
    publish?.({ zoomLevel: 5 });
    resolveInitial({ zoomLevel: -3 });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Zoom in" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled"),
    ).toBe(false);
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
