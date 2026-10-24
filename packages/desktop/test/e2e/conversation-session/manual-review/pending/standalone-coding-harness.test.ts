import { type NetworkCaptureBridge } from "@zcode/shared";
import {
  TID_CHAT_ERROR_BANNER,
  TID_V4_COMPOSER_INPUT,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import { createAndConfigurePersonalProvider } from "../../../helpers/personal-provider-settings.js";
import { restartIntoWorkspacePreservingProfile } from "../../../helpers/model-provider-restart-runtime.js";
import {
  openResourceManager,
  switchToElectronRendererTarget,
  isResourceManagerUrl,
  waitForResourceManagerReady,
  isMainRendererUrl,
  closeResourceManagerWindow,
} from "../../../helpers/resource-manager.js";

describe("独立桌面 Coding Harness", () => {
  it("H01/H02：匿名空配置进入桌面，草稿保留，普通 GLM API 重启恢复", async function () {
    this.timeout(120000);
    await waitForDefaultWorkspaceReady(30000);
    expect(await readModelProviders()).toHaveLength(0);
    expect(await $('[data-testid="login-use-api-key-button"]').isExisting()).toBe(false);
    const draft = "E2E_STANDALONE_DRAFT";
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, draft);
    expect(await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).getText()).toBe(draft);
    expect(
      await $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`).getAttribute("data-error-code"),
    ).toBe("model_config_missing");
    const missingModelCopy = await $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`).getText();
    expect(missingModelCopy).toMatch(/模型 API|model API/i);
    expect(missingModelCopy).not.toMatch(/套餐|升级|登录|upgrade|sign in/i);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await createAndConfigurePersonalProvider({
      templateId: "bigmodel-standard-api",
      providerName: "E2E_STANDALONE_GLM",
      apiKey: "e2e-personal-api-key",
      baseURL: "http://127.0.0.1:9/v1",
    });
    const before = await readModelProviders();
    expect(before).toHaveLength(1);
    expect(before[0]?.apiKey).toBe("e2e-personal-api-key");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    // helper 的时间戳是读取时生成的兼容投影，只比较真正落盘的配置。
    const persistedFields = ({
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...config
    }: (typeof before)[number]) => config;
    expect((await readModelProviders()).map(persistedFields)).toEqual(before.map(persistedFields));
    expect(await $('[data-testid="login-use-api-key-button"]').isExisting()).toBe(false);
  });

  it("H07：本地诊断采样期间无原厂业务请求", async function () {
    this.timeout(60000);
    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    // 等待一次窗口快照和跨进程批次，以真实采样完成作为观测屏障。
    // 有意观察十秒空闲期，确认没有后台商业轮询。
    await browser.pause(10000);
    const snapshot = await browser.execute(async () => {
      const bridge = (
        window as unknown as Window & { resourceManager: { network: NetworkCaptureBridge } }
      ).resourceManager;
      return bridge.network.getSnapshot();
    });
    expect(snapshot.dropped).toBe(0);
    const official = snapshot.records.filter(({ url }) => {
      const parsed = new URL(url);
      return (
        /(?:codegeex\.cn|zcode\.z\.ai|zcode-ai\.com)$/.test(parsed.hostname) ||
        /\/(?:api\/v1\/)?(?:client\/configs|marketing|entitlement|rewards|share|usage\/quota|ultra)(?:\/|$)/.test(
          parsed.pathname,
        )
      );
    });
    expect(official).toEqual([]);
    await closeResourceManagerWindow();
    await switchToElectronRendererTarget(isMainRendererUrl);
  });
});
