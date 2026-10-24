import { TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver, waitForDefaultWorkspaceReady } from "./helpers/desktop-app.js";

describe("独立桌面帮助菜单", () => {
  it("只提供本地帮助能力，不出现更新、社区或商业入口", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await clickTestIdByWebDriver(TID_WORKSPACE_HELP_MENU_TRIGGER);
    const text = await $('[role="menu"]').getText();
    expect(text).not.toMatch(/检查更新|Check for Updates|升级套餐|Upgrade Plan|Community|社区/i);
    await browser.keys("Escape");
  });
});
