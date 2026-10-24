import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  getE2EAppDataPaths,
} from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "../helpers/upstream-capture.js";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "../helpers/upstream-provider.js";
import {
  E2E_GLM_PROVIDER_ID,
  E2E_GLM_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "../helpers/model-provider-restart.js";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("模型 Provider 重启恢复 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: UPSTREAM_PROVIDER_ID,
      models: [{ id: UPSTREAM_MODEL, reasoningLevel: { values: ["high", "max"], map: "{}" } }],
      name: "Upstream E2E",
    });
  });

  it("I25/MP-R01: 重启保留仍可用的 上游 last-selected", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R01", UPSTREAM_MODEL);
  });

  it("I26/MP-R02: 重启保留普通 API Provider 内非首个模型", async function () {
    this.timeout(180000);
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedReplayProvider({
          id: E2E_GLM_PROVIDER_ID,
          name: "GLM API E2E",
          models: [
            "GLM-5.2",
            {
              id: E2E_GLM_NON_DEFAULT_MODEL,
              reasoningLevel: { values: ["disabled", "high", "max"], map: "{}" },
            },
          ],
        });
      },
    });
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_MODEL_PROVIDER_RESTART_R02 draft");
    await switchV4Model(E2E_GLM_PROVIDER_ID, E2E_GLM_NON_DEFAULT_MODEL, "max");
    await restartIntoWorkspacePreservingProfile(getE2EAppDataPaths().workspace);
    await waitForSelectedModel(E2E_GLM_PROVIDER_ID, E2E_GLM_NON_DEFAULT_MODEL);
    await waitForRestartedDraftModelReady(E2E_GLM_PROVIDER_ID, E2E_GLM_NON_DEFAULT_MODEL);
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R02", E2E_GLM_NON_DEFAULT_MODEL);
  });

  it("I27/MP-R03: 旧官方套餐选择失效时留空，手动选择后可发送", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: E2E_GLM_NON_DEFAULT_MODEL,
      providerId: "account:bigmodel-start-plan",
      reasoningLevel: "max",
    });
    await restartIntoWorkspace();
    await assertUnavailableSelectionRequiresUserChoice();
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R03", UPSTREAM_MODEL);
  });

  it("I28/MP-R04: 已不可用 last-selected 留空，手动选择后可发送", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: "upstream-removed-e2e",
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace();
    await assertUnavailableSelectionRequiresUserChoice();
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R04", UPSTREAM_MODEL);
  });
});

async function assertRequestUsesModel(marker: string, model: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  // Bug 根因：重启后 toolbar 会早于 draft runtime binding 完成水合；旧 case
  // 发送后直接等待 complete capture，无法区分“点击没有进入 runtime”和“请求响应慢”。
  // request-start 是物理 admission 屏障，complete capture 再负责模型与响应断言。
  await waitForUpstreamNetworkRequestStarted(marker);
  const capture = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(capture, { expectedText: prompt, model });
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
  await waitForV4Pane((snapshot) => !snapshot.canStop, `${marker} 没有完成`, 90000);
}

async function waitForRestartedDraftModelReady(provider: string, model: string) {
  await waitForV4ComposerSelectionReady();
  let latest = await getV4ModelConfig();
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      const matched =
        latest.source === "composer" && latest.provider === provider && latest.model === model;
      if (!matched) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= 300;
    },
    {
      timeout: 30000,
      timeoutMsg: `重启后的 draft provider/runtime 没有稳定就绪: ${JSON.stringify({
        expected: { model, provider },
        latest,
      })}`,
    },
  );
}

async function assertUnavailableSelectionRequiresUserChoice() {
  // Todo 71 已取消失效选择自动回退；必须验证禁发和用户显式修复，不能等待默认模型。
  await browser.waitUntil(async () => !(await getV4ModelConfig()).model, {
    timeout: 30_000,
    timeoutMsg: "失效模型不应自动回退到默认模型",
  });
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_INVALID_SELECTION_NOT_SENT");
  expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");
  await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "max");
  await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
}
