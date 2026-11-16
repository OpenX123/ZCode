import { describe, expect, it } from "vitest";
import { resolveTopOverlayLeadingPaddingClass } from "@/WorkspaceHeader.js";

// WorkspaceHeader 与 Side Pane 完整视图 tab 栏共用：侧栏收起时给左上角浮层按钮组让位。
describe("resolveTopOverlayLeadingPaddingClass", () => {
  it("does not reserve space while the sidebar is visible", () => {
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: true, isMacDesktop: true }),
    ).toBe(false);
  });

  it("reserves the macOS traffic lights plus overlay buttons", () => {
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false, isMacDesktop: true }),
    ).toBe("pl-58");
    expect(
      resolveTopOverlayLeadingPaddingClass({
        isSidebarVisible: false,
        isMacDesktop: true,
        isMacFullscreen: true,
        hasUpdateReady: true,
      }),
    ).toBe("pl-48");
  });

  it("reserves only the overlay buttons on Windows and Linux", () => {
    expect(resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false })).toBe("pl-38");
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false, hasUpdateReady: true }),
    ).toBe("pl-44");
  });

  it.each([
    [false, false, false, "pl-38", "pl-22"],
    [false, false, true, "pl-44", "pl-28"],
    [false, true, false, "pl-38", "pl-22"],
    [false, true, true, "pl-44", "pl-28"],
    [true, false, false, "pl-58", "pl-42"],
    [true, false, true, "pl-66", "pl-50"],
    [true, true, false, "pl-38", "pl-22"],
    [true, true, true, "pl-48", "pl-32"],
  ] as const)(
    "keeps wide spacing and removes only hidden navigation space: mac=%s fullscreen=%s update=%s",
    (isMacDesktop, isMacFullscreen, hasUpdateReady, wide, compact) => {
      const flags = { isMacDesktop, isMacFullscreen, hasUpdateReady };
      expect(
        resolveTopOverlayLeadingPaddingClass({
          ...flags,
          isSidebarVisible: false,
          isCompactViewport: false,
        }),
      ).toBe(wide);
      expect(
        resolveTopOverlayLeadingPaddingClass({
          ...flags,
          isSidebarVisible: false,
          isCompactViewport: true,
        }),
      ).toBe(compact);
      expect(
        resolveTopOverlayLeadingPaddingClass({
          ...flags,
          isSidebarVisible: true,
          isCompactViewport: true,
        }),
      ).toBe(false);
    },
  );
});
