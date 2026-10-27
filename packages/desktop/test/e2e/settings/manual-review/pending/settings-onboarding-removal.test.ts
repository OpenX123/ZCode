import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import { sel } from "../../../helpers/selectors.js";

describe("设置移除失效职业引导入口", () => {
  after(async () => {
    await clearAppData();
  });

  it("设置侧栏和常规页不再提供引导，其余分区仍可切换", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
    const settings = $(sel(TID_SETTINGS_PAGE));
    await settings.waitForDisplayed({ timeout: 15000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));

    // 旧按钮只写入无人读取的状态，必须从侧栏和常规页一起退出。
    const onboarding = await settings
      .$$("button")
      .filter(async (button) =>
        /^(引导|打开引导|Onboard|Open onboarding)$/.test((await button.getText()).trim()),
      );
    expect(onboarding).toHaveLength(0);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "appearance"));
    expect(await settings.isDisplayed()).toBe(true);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    expect(await settings.isDisplayed()).toBe(true);
  });
});
