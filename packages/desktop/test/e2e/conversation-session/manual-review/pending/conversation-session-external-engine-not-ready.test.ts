// E01 / E03：只验证未安装门禁与登录引导，不安装 adapter、不请求官方模型。
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
} from "@zcode/shared/test-ids";
import { setInputValueByTestIdDom } from "../../../helpers/desktop-app.js";
import { getV4ComposerText, prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

describe("外部引擎未就绪保持草稿", () => {
  it("两家引擎均隐藏内置配置，发送被门禁且保留文本，设置展示官方登录命令", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    for (const engine of ["Claude Code", "Codex"]) {
      const selector = $('[data-testid="session-engine-select"]');
      await selector.waitForClickable({ timeout: 30000 });
      await selector.click();
      const choice = $(`[role="option"]=${engine}`);
      await choice.waitForClickable({ timeout: 5000 });
      await choice.click();
      await expect($(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`)).not.toExist();
      await expect($(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`)).not.toExist();
      const prompt = `E2E_EXTERNAL_ENGINE_NOT_READY ${engine} 草稿`;
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, prompt);
      const send = $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`);
      await send.waitForClickable({ timeout: 30000 });
      await send.click();
      await browser.waitUntil(
        async () => (await $('[role="alert"]').getText()).includes("草稿已保留"),
        { timeout: 15000 },
      );
      expect(await getV4ComposerText()).toContain(prompt);
    }
    await $("button=配置 Agent 引擎").click();
    const settings = $('[data-testid="agent-engine-settings"]');
    await settings.waitForDisplayed({ timeout: 15000 });
    const engineNav = $('[data-settings-section-nav="agentEngines"]');
    await expect(engineNav).toHaveAttribute("aria-current", "page");
    expect(
      await browser.execute(() => {
        const items = Array.from(document.querySelectorAll("[data-settings-section-nav]"));
        const modelIndex = items.findIndex(
          (item) => item.getAttribute("data-settings-section-nav") === "modelProvider",
        );
        return items[modelIndex + 1]?.getAttribute("data-settings-section-nav");
      }),
    ).toBe("agentEngines");
    const text = await settings.getText();
    expect(text).toContain("claude auth login");
    expect(text).toContain("codex login");
    // 首次只读检测完成前安装按钮会禁用；等待实际可用状态，避免把加载过程误判为安装失败。
    await expect($('[data-testid="engine-install-claude-code"]')).toBeEnabled();
    await expect($('[data-testid="engine-install-codex"]')).toBeEnabled();
    const details = $('[data-testid="engine-settings-claude-code"] details');
    expect(await details.getAttribute("open")).toBeNull();
    await details.$("summary").click();
    await expect(details).toHaveAttribute("open");
    await $('[data-settings-section-nav="modelProvider"]').click();
    await expect(settings).not.toExist();
    await expect($('[data-model-provider-split-panel="true"]')).toBeDisplayed();
    await engineNav.click();
    await expect(settings).toBeDisplayed();
    expect(await browser.execute(() => localStorage.getItem("zcode-settings-last-section"))).toBe(
      "agentEngines",
    );
  });
});
