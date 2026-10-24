import { describe, expect, it } from "vitest";
import {
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";

describe("独立桌面启动", () => {
  it("H01 不因账号或模型缺失阻塞桌面", () => {
    expect(
      shouldBlockRootRender({ isRestoring: false, isBootstrappingInitialWorkspace: false }),
    ).toBe(false);
  });
  it("恢复标签和注入初始工作区时等待本地恢复", () => {
    expect(
      shouldBlockRootRender({ isRestoring: true, isBootstrappingInitialWorkspace: false }),
    ).toBe(true);
    expect(
      shouldShowRootStartupLoading({
        isDesktop: true,
        isRestoring: false,
        isBootstrappingInitialWorkspace: true,
      }),
    ).toBe(true);
  });
  it("迟到的兜底目录不抢占已恢复工作区", () => {
    expect(
      shouldOpenFallbackWorkspaceAfterCreate({
        isMounted: true,
        activeWorkspacePath: "/workspace/existing",
      }),
    ).toBe(false);
  });
});
