/** 桌面更新只读投影与双入口，所有副作用经平台接口进入 Main。 */
export const desktopUpdatesUiModule = {
  id: "desktop-updates-ui",
  requires: ["ui", "shared"],
  provides: ["desktop-updates-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "../hooks/desktop-updates/index.ts"],
} as const;
