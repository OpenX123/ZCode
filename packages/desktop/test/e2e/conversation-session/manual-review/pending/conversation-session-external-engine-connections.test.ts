// C05 / C06：连接配置的新建、设为默认与删除只隐藏；不安装 adapter、不请求真实模型，密钥为测试占位值。
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { join } from "node:path";
import {
  clickTestIdByDom,
  setCurrentElectronRendererContentSize,
} from "../../../helpers/desktop-app.js";
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
    const settings = $('[data-testid="agent-engine-settings"]');
    await settings.$('button[aria-label="Codex"]').click();
    await expect($('[data-testid="engine-settings-codex"]')).toBeDisplayed();
    await expect($('[data-testid="engine-settings-claude-code"]')).not.toBeDisplayed();
    await settings.$('button[aria-label="Claude Code"]').click();
    const list = $('[data-testid="engine-connection-claude-codes"]');
    await list.waitForDisplayed({ timeout: 15000 });
    expect(await list.getText()).toContain("官方登录");
    await $('[data-testid="engine-connection-claude-code-add"]').click();
    const form = $('[data-testid="engine-connection-claude-code-form"]');
    await form.waitForDisplayed({ timeout: 5000 });
    await expect($('[role="dialog"]')).toBeDisplayed();
    await form.$("#engine-connection-claude-code-name").setValue("E2E 取消的连接");
    await form.$("button=取消").click();
    await expect(form).not.toExist();
    expect(await list.getText()).not.toContain("E2E 取消的连接");
    await $('[data-testid="engine-connection-claude-code-add"]').click();
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
    let row = $(
      '//li[starts-with(@data-testid,"engine-connection-claude-code-")][contains(., "E2E 网关")]',
    );
    expect(await row.getText()).toContain("上次使用");
    const originalId = await row.getAttribute("data-testid");
    // 查看仅切详情；必须显式“用于新任务”才更改默认连接。
    await $('[data-testid="engine-connection-claude-code-view-official"]').click();
    expect(await row.getText()).toContain("上次使用");
    expect(await $('[data-testid="engine-connection-claude-code-detail"]').getText()).toContain(
      "官方登录",
    );
    await $('[data-testid="engine-connection-claude-code-official"]')
      .$("button=用于新任务")
      .click();
    await browser.waitUntil(async () =>
      (await $('[data-testid="engine-connection-claude-code-official"]').getText()).includes(
        "上次使用",
      ),
    );
    await row.$("button=E2E 网关").click();
    await row.$("button=用于新任务").click();
    await browser.waitUntil(async () => (await row.getText()).includes("上次使用"));
    await row.$("button=编辑").click();
    await form.waitForDisplayed();
    expect(await form.$("#engine-connection-claude-code-key").getValue()).toBe("");
    await form.$("#engine-connection-claude-code-name").setValue("E2E 网关已编辑");
    await form.$("button=保存").click();
    row = $(
      '//li[starts-with(@data-testid,"engine-connection-claude-code-")][contains(., "E2E 网关已编辑")]',
    );
    await row.waitForDisplayed({ timeout: 15000 });
    expect(await row.getAttribute("data-testid")).not.toBe(originalId);
    expect(await settings.getText()).not.toContain(FIXTURE_KEY);
    const artifact = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!artifact) throw new Error("缺少 E2E 截图目录");
    for (const [width, size] of [
      [1280, "wide"],
      [640, "narrow"],
    ] as const) {
      await setCurrentElectronRendererContentSize(width, 800);
      for (const theme of ["light", "dark"]) {
        await browser.execute((value) => {
          const actions = (
            window as typeof window & { __testActions?: { setTheme?: (theme: string) => void } }
          ).__testActions;
          if (!actions?.setTheme) throw new Error("缺少主题入口");
          actions.setTheme(value);
        }, theme);
        await browser.waitUntil(async () =>
          browser.execute(
            (dark) => document.documentElement.classList.contains("dark") === dark,
            theme === "dark",
          ),
        );
        expect(
          await browser.execute(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await browser.saveScreenshot(join(artifact, `acp-settings-${size}-${theme}.png`));
      }
    }
    await setCurrentElectronRendererContentSize(1280, 800);
    await row.$("button=删除").click();
    await row.$("button=确认删除").click();
    await browser.waitUntil(async () => !(await list.getText()).includes("E2E 网关"), {
      timeout: 15000,
      timeoutMsg: "删除后连接仍出现在列表中",
    });
    expect(await $('[data-testid="engine-connection-claude-code-official"]').getText()).toContain(
      "上次使用",
    );
  });
});
