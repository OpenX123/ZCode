// C05 / C06：连接配置的新建、设为默认与删除只隐藏；不安装 adapter、不请求真实模型，密钥为测试占位值。
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "../../../helpers/desktop-app.js";
import { sel } from "../../../helpers/selectors.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const FIXTURE_KEY = "e2e-connection-placeholder-key";

async function openAgentEngineSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentEngines"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现 Agent 引擎分区入口",
  });
  await $('[data-testid="agent-engine-settings"]').waitForDisplayed({ timeout: 15000 });
}

describe("外部引擎连接配置", () => {
  it("新建 Claude 网关连接后成为默认并显示网关，删除需确认且回落官方登录", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await openAgentEngineSettings();
    const list = $('[data-testid="engine-connection-claude-codes"]');
    await list.waitForDisplayed({ timeout: 15000 });
    expect(await list.getText()).toContain("官方登录");
    await $('[data-testid="engine-connection-claude-code-add"]').click();
    const form = $('[data-testid="engine-connection-claude-code-form"]');
    await form.waitForDisplayed({ timeout: 5000 });
    await form.$("#engine-connection-claude-code-name").setValue("E2E 网关");
    await form.$("#engine-connection-claude-code-url").setValue("https://claude-gw.example");
    await form.$("#engine-connection-claude-code-key").setValue(FIXTURE_KEY);
    await form.$("button=保存").click();
    await browser.waitUntil(
      async () => (await list.getText()).includes("使用网关 claude-gw.example"),
      {
        timeout: 15000,
        timeoutMsg: "新建的网关连接没有出现在列表中",
      },
    );
    const settingsText = await $('[data-testid="agent-engine-settings"]').getText();
    expect(settingsText).not.toContain(FIXTURE_KEY);
    const row = $(
      '//li[starts-with(@data-testid,"engine-connection-claude-code-")][contains(., "E2E 网关")]',
    );
    expect(await row.getText()).toContain("默认");
    await row.$("button=删除").click();
    await row.$("button=确认删除").click();
    await browser.waitUntil(async () => !(await list.getText()).includes("E2E 网关"), {
      timeout: 15000,
      timeoutMsg: "删除后连接仍出现在列表中",
    });
    expect(await $('[data-testid="engine-connection-claude-code-official"]').getText()).toContain(
      "默认",
    );
  });
});
