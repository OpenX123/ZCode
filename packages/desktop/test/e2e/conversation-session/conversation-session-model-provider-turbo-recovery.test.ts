import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import { ModelConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { clearAppData, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { refreshSeededOpenAIProvidersThroughSettings } from "../helpers/custom-openai-provider.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_PROVIDER_ID,
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "../helpers/upstream-provider.js";
import {
  E2E_GLM_PROVIDER_ID,
  E2E_GLM_TURBO_MODEL,
  restartIntoWorkspace,
  restartIntoWorkspacePreservingProfile,
  seedTurboAgentStartupModel,
  seedGlobalAgentReasoningLevel,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForDraftThoughtLevelState,
  waitForLastSelectedAgentConfig,
  waitForModelIoRequest,
  waitForSelectedModel,
} from "../helpers/model-provider-restart.js";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("模型 Provider Turbo 重启恢复 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  before(async () => {
    await skipOccupationOnboardingIfPresent();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  for (const binary of [false, true]) {
    it(`${binary ? "binary" : "sole enabled"} effort status presentation`, async function () {
      this.timeout(180000);
      await seedPersistedModelSelection({
        providerId: UPSTREAM_PROVIDER_ID,
        modelId: UPSTREAM_MODEL,
        reasoningLevel: "enabled",
      });
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          const repository = new NodePersonalProviderConfigRepository({
            filePath: getE2EAppDataPaths().configFile,
            pollingIntervalMs: false,
          });
          try {
            await repository.update((current) => ({
              ...current,
              models: current.models.setExact(
                UPSTREAM_PROVIDER_ID,
                UPSTREAM_MODEL,
                ModelConfig.fromData({
                  enabled: true,
                  optionSpecs: {
                    reasoningLevel: { values: binary ? ["disabled", "enabled"] : ["enabled"] },
                  },
                }),
              ),
            }));
          } finally {
            repository.dispose();
          }
          await seedGlobalAgentReasoningLevel("enabled");
        },
      });
      await selectUpstreamProviderModelById(UPSTREAM_SECONDARY_MODEL);
      await selectUpstreamProviderModelById(UPSTREAM_MODEL);
      await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
      const trigger = $('[data-testid="chat-model-select-trigger"]');
      await trigger.click();
      if (binary) {
        const slider = $('[data-testid="composer-thought-slider"]');
        await slider.waitForDisplayed();
        expect(await slider.getAttribute("max")).toBe("1");
        await slider.click();
        await browser.keys("Home");
        await browser.waitUntil(async () => (await slider.getValue()) === "0");
        expect(await slider.getAttribute("aria-valuetext")).toMatch(/Off|关闭/);
        await browser.keys("End");
        await browser.waitUntil(async () => (await slider.getValue()) === "1");
        expect(await slider.getAttribute("aria-valuetext")).toMatch(/On|开启/);
      } else {
        await $('[data-testid="composer-thought-value"]').waitForDisplayed();
        expect(await $('[data-testid="composer-thought-value"]').getText()).toMatch(/On|开启/);
        expect(await $('[data-testid="composer-thought-slider"]').isExisting()).toBe(false);
        expect(await $('[data-testid="composer-effort-shortcut"]').isExisting()).toBe(false);
      }
      expect(await $('[data-testid="composer-thought-switch"]').isExisting()).toBe(false);
      await browser.keys("Escape");
      await browser.waitUntil(
        async () => (await trigger.getAttribute("aria-expanded")) === "false",
      );
      await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    });
  }

  it("I35/MP-T01: Turbo off 重启后保持二态思考能力", async function () {
    this.timeout(180000);
    await restartWithTurboProviderFixture();
    await selectTurboBeforeRestart("disabled");
    await restartIntoWorkspacePreservingProfile();
    await waitForSelectedModel(E2E_GLM_PROVIDER_ID, E2E_GLM_TURBO_MODEL);
    await waitForDraftThoughtLevelState({ current: "disabled", values: ["disabled", "enabled"] });
  });

  it("I36/MP-T02: Turbo enabled 重启后首发保持模型和思考档位", async function () {
    this.timeout(180000);
    await restartWithTurboProviderFixture();
    await selectTurboBeforeRestart("enabled");
    await restartIntoWorkspacePreservingProfile();
    await waitForSelectedModel(E2E_GLM_PROVIDER_ID, E2E_GLM_TURBO_MODEL);
    await waitForDraftThoughtLevelState({ current: "enabled", values: ["disabled", "enabled"] });
    const marker = "E2E_MODEL_PROVIDER_RESTART_T02";
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
    const request = await waitForModelIoRequest(marker);
    expect(request?.model).toBe(E2E_GLM_TURBO_MODEL);
    expect(request?.thinking?.type).toBe("enabled");
  });

  it("I37/MP-T03: Turbo 二态连续切换时模型保持稳定", async function () {
    this.timeout(180000);
    await prepareTurboDraft("disabled");
    for (const thoughtLevel of ["enabled", "disabled"] as const) {
      const trigger = $('[data-testid="chat-model-select-trigger"]');
      await trigger.click();
      const slider = $('[data-testid="composer-thought-slider"]');
      await slider.waitForDisplayed();
      expect(await $('[data-testid="composer-thought-switch"]').isExisting()).toBe(false);
      expect(await $('[data-testid="composer-thought-endpoints"]').isExisting()).toBe(false);
      await slider.click();
      await browser.keys(thoughtLevel === "enabled" ? "End" : "Home");
      await browser.waitUntil(
        async () => (await slider.getValue()) === (thoughtLevel === "enabled" ? "1" : "0"),
      );
      expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      await waitForSelectedModel(E2E_GLM_PROVIDER_ID, E2E_GLM_TURBO_MODEL);
      await waitForDraftThoughtLevelState({
        current: thoughtLevel,
        values: ["disabled", "enabled"],
      });
      await browser.performActions([
        {
          type: "pointer",
          id: "effort-outside",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, x: 4, y: 100 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await browser.waitUntil(
        async () => (await trigger.getAttribute("aria-expanded")) === "false",
      );
    }
  });
});

async function prepareTurboDraft(thoughtLevel: "disabled" | "enabled") {
  await restartWithTurboProviderFixture();
  // I37 只验证当前 deferred draft 的连续二态切换；冷启动恢复由 I35/I36 覆盖。
  // 旧准备流程额外重启 App，把 DOMStorage/SQLite 冷启动竞态错误叉乘进本 case。
  await selectTurboDraft(thoughtLevel);
}

async function restartWithTurboProviderFixture() {
  // Bug 根因：运行中的 Host/Agent 会在退出阶段把已加载的旧 provider 快照写回磁盘；
  // direct seed 若发生在进程存活期，Turbo 会在下一次冷启动前被旧快照覆盖。
  // 统一在 Electron 进程树退出屏障内写入，让新进程成为唯一 reader/writer。
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedReplayProvider({
        id: E2E_GLM_PROVIDER_ID,
        name: "GLM API E2E",
        models: [
          {
            id: E2E_GLM_TURBO_MODEL,
            reasoningLevel: {
              values: ["disabled", "enabled"],
              map: '{"thinking":{"type": reasoningLevel}}',
            },
          },
        ],
      });
    },
  });
}

async function selectTurboBeforeRestart(thoughtLevel: "disabled" | "enabled") {
  await selectTurboDraft(thoughtLevel);
  // 隔离动态 Provider 的会话持久态可能尚未写入完整关系数据，Agent 日志会记录
  // session.model_selection.persist_failed(FK)，因此不能把该 fixture 缺失的落盘副作用
  // 当成恢复 case 的前置条件。真实 UI/Agent 状态确认后补齐 renderer 原子偏好元组，
  // 让本 case 专注验证下一次启动是否正确消费该持久态。
  await seedPersistedModelSelection({
    modelId: E2E_GLM_TURBO_MODEL,
    providerId: E2E_GLM_PROVIDER_ID,
    reasoningLevel: thoughtLevel,
  });
  await waitForLastSelectedAgentConfig({
    model: E2E_GLM_TURBO_MODEL,
    thoughtLevel,
  });
  // 用户真实切换会同步写 Agent 的全局 reasoningLevel；E2E 的动态 provider
  // session store 不保证跨 Agent 进程保留这条副作用，因此在 schema ready 后补齐状态。
  await seedGlobalAgentReasoningLevel(thoughtLevel);
  await seedTurboAgentStartupModel(E2E_GLM_PROVIDER_ID, E2E_GLM_TURBO_MODEL);
}

async function selectTurboDraft(thoughtLevel: "disabled" | "enabled") {
  // 修复原因：直接写 localStorage 只伪造了 renderer 偏好，没有触发真实选择动作对
  // deferred session / Agent 状态的同步；重启后旧 workspace model 会反向覆盖该偏好。
  // 这里走真实工具栏交互，使前置状态与用户手动选择 Turbo + 思考档位完全一致。
  // 打开 Provider 设置触发目录刷新，再等待工具栏消费新的 Personal 配置。
  await refreshSeededOpenAIProvidersThroughSettings([]);
  await selectUpstreamProviderModelById(E2E_GLM_TURBO_MODEL, {
    providerId: E2E_GLM_PROVIDER_ID,
    providerName: "GLM API E2E",
    includePlainModelFallback: false,
  });
  // Turbo 切换后 UI 会先投影默认档位；若目标恰好等于投影值，通用 helper 会因
  // “已经选中”直接返回，实际不会发出 reasoning_effort 更新。先切到相反档位再
  // 切回目标，确保 disabled/enabled 两条 case 都建立真实用户交互产生的持久状态。
  await selectUpstreamThoughtLevelValue(thoughtLevel === "enabled" ? "disabled" : "enabled");
  await selectUpstreamThoughtLevelValue(thoughtLevel);
  await waitForSelectedModel(E2E_GLM_PROVIDER_ID, E2E_GLM_TURBO_MODEL);
  await waitForDraftThoughtLevelState({
    current: thoughtLevel,
    values: ["disabled", "enabled"],
  });
}
