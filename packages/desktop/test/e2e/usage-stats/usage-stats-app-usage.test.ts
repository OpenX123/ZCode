import { TID_SETTINGS_SECTION_NAV, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "../helpers/desktop-app.js";

describe("Usage Stats App Usage E2E", () => {
  after(async () => {
    await clearAppData();
  });

  // 本机多来源面板（docs/usage-stats-local-sources.md）：ZCode 原生 usage facts 经 CLI 读取，
  // 隔离 HOME 下没有 Claude Code / Codex 日志。
  it("US-AU-02/03/04/05: 本机多来源聚合、range、Token Activity 与按模型明细", async function () {
    this.timeout(120_000);
    await openAppUsage();

    await assertBodyIncludes(["e2e-model-alpha", "e2e-model-beta"]);
    await assertBodyIncludesAny(["Token Activity", "Token 活动"]);
    await assertBodyIncludesAny(["Usage trend", "用量趋势"]);
    await assertBodyIncludesAny(["Estimated at API prices", "按 API 价格估算"]);
    await assertBodyIncludesAny(["ZCode runtime metrics", "ZCode 运行指标"]);

    await clickButtonByText(["Weekly", "每周"]);
    await assertPressedButton(["Weekly", "每周"]);
    await clickButtonByText(["Cumulative", "累计"]);
    await assertPressedButton(["Cumulative", "累计"]);

    await clickButtonByText(["30 days", "30 天"]);
    await assertPressedButton(["30 days", "30 天"]);
    await assertBodyIncludes(["e2e-model-gamma"]);
  });

  it("US-AU-01: 没有日志的来源显示确定空态并隐藏 ZCode 运行指标", async function () {
    this.timeout(60_000);
    await clickButtonByText(["Codex"]);
    await assertPressedButton(["Codex"]);
    await browser.waitUntil(async () => /No usage yet|暂无用量/.test(await $("body").getText()), {
      timeout: 20_000,
      timeoutMsg: "Codex 来源没有显示空态",
    });
    await assertBodyExcludes(["e2e-model-alpha", "ZCode 运行指标", "ZCode runtime metrics"]);
  });
});

async function openAppUsage(): Promise<void> {
  await waitForDefaultWorkspaceReady(60_000);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 20_000,
    timeoutMsg: "App Usage E2E 无法打开设置页",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "usage"), {
    timeout: 20_000,
    timeoutMsg: "设置页 Usage 分区没有出现",
  });
  await browser.waitUntil(
    async () => /Token activity|Token 活动/i.test(await $("body").getText()),
    { timeout: 30_000, timeoutMsg: "本机用量数据没有完成加载" },
  );
}

async function clickButtonByText(labels: string[]): Promise<void> {
  for (const button of await $$("button")) {
    if (labels.includes((await button.getText()).trim())) {
      await button.click();
      return;
    }
  }
  throw new Error(`找不到按钮: ${labels.join("/")}`);
}

async function assertPressedButton(labels: string[]): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((candidateLabels) => {
        const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => candidateLabels.includes(button.textContent?.trim() ?? ""),
        );
        return target?.getAttribute("data-state") === "active";
      }, labels),
    { timeout: 10_000, timeoutMsg: `${labels.join("/")} 没有进入 active 状态` },
  );
}

async function assertBodyIncludes(values: string[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const body = await $("body").getText();
      const normalizedBody = body.toLocaleLowerCase();
      return values.every((value) => normalizedBody.includes(value.toLocaleLowerCase()));
    },
    { timeout: 20_000, timeoutMsg: `页面缺少文本: ${values.join(", ")}` },
  );
}

async function assertBodyIncludesAny(values: string[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const body = await $("body").getText();
      const normalizedBody = body.toLocaleLowerCase();
      return values.some((value) => normalizedBody.includes(value.toLocaleLowerCase()));
    },
    { timeout: 20_000, timeoutMsg: `页面未出现任一文本: ${values.join(", ")}` },
  );
}

async function assertBodyExcludes(values: string[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const body = await $("body").getText();
      return values.every((value) => !body.includes(value));
    },
    { timeout: 20_000, timeoutMsg: `页面仍包含文本: ${values.join(", ")}` },
  );
}
