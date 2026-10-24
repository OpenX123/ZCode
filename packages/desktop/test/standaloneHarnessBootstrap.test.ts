import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("独立 Coding Harness 桌面启动边界", () => {
  it("主进程不装配原厂账号、远控、更新或遥测客户端", async () => {
    const source = await readSource("../src/main/index.ts");
    for (const factory of [
      "createWebRemoteControlManager(",
      "createTelemetryCore(",
      "createAppTelemetryRuntime(",
      "createElectronDesktopContextPromptConfigFetcher(",
      "initAutoUpdater(",
      "maybeBlockStartupForForceUpdate(",
      "armsInitPromise",
    ])
      expect(source.includes(factory)).toBe(false);
  });

  it("账号菜单不显示登录、套餐、邀请或手机配对入口", async () => {
    const source = await readSource("../../ui/src/WorkspaceSidebarFooter.tsx");
    for (const entry of [
      "useOpenRewards",
      "WorkspaceSidebarFooterUsageSummaryContent",
      "WorkspaceSidebarFooterPlanBadge",
      "WorkspaceWebRemoteControlTrigger",
      'id: "app.login"',
      'id: "app.logout"',
    ])
      expect(source.includes(entry)).toBe(false);
  });

  it("帮助菜单只保留本地诊断，不触发官网帮助配置或更新", async () => {
    const source = await readSource("../../ui/src/WorkspaceHelpMenuButton.tsx");
    for (const entry of [
      "useVulnerabilityReportUrl",
      "useDesktopUpdateMenu",
      "useFeedbackStore",
      "openCommunity",
      "openProductDocs",
    ])
      expect(source.includes(entry)).toBe(false);
    expect(source).toContain("exportLogs");
    expect(source).toContain("OpenResourceManager");
  });
  it("会话发送和展示不接入分享发布、高速推广或官方额度拦截", async () => {
    const source = await readSource("../../ui/src/v4/SessionPane.tsx");
    for (const entry of [
      "prepareHighspeedSendContext",
      "useV4SessionQuotaBanner",
      "useStartPlanRecommendation",
      "ConversationSharePopover",
      "onFeedbackChange=",
    ])
      expect(source.includes(entry)).toBe(false);
    expect(source).toContain("getImportedConversation");
    expect(source).toContain("ConversationShareImportNotice");
  });
  it("桌面壳层没有官方账号回调，首输出观测不装配导出链路", async () => {
    for (const path of [
      "../../ui/src/App.tsx",
      "../../ui/src/app-shell/types.ts",
      "../../ui/src/app-shell/WorkspaceShellLayout.tsx",
      "../../ui/src/project-sidebar/contract.ts",
    ]) {
      const source = await readSource(path);
      expect(source).not.toContain("onLogin");
      expect(source).not.toContain("onLogout");
      expect(source).not.toContain("UserInfo");
    }
    const bootstrap = await readSource("../src/renderer/src/localTtftBootstrap.ts");
    expect(bootstrap).toContain("setLocalTtftObserver(observer)");
    expect(bootstrap).not.toContain("window.zcode");
    expect(bootstrap).not.toMatch(/telemetry|exporter|reportApp/i);
    const preload = await readSource("../src/preload/index.ts");
    expect(preload).not.toContain("reportLocalTtft");
    expect(preload).not.toContain("reportAppTelemetry");
  });
});
