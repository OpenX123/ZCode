import { join } from "node:path";
import { TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver, waitForDefaultWorkspaceReady } from "./helpers/desktop-app.js";

describe("独立桌面帮助菜单", () => {
  it("提供检查更新和本地帮助，不出现社区或商业入口", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await clickTestIdByWebDriver(TID_WORKSPACE_HELP_MENU_TRIGGER);
    const menu = $('[role="menu"][data-state="open"]');
    await expect(menu).toBeDisplayed();
    await expect(menu).toHaveText(expect.stringMatching(/检查更新|Check for Updates/i));
    const text = await menu.getText();
    expect(text).not.toMatch(/升级套餐|Upgrade Plan|Community|社区/i);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "help-check-updates.png"),
    );
    await browser.keys("Escape");
  });
});
