import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { getE2EAppDataPaths, setInputValueByTestIdDom } from "./desktop-app.js";
import { restartIntoWorkspace } from "./model-provider-restart.js";
import { seedPersonalProviderConfig } from "./model-provider-restart-config.js";
import { skipOccupationOnboardingIfPresent } from "./occupation-onboarding.js";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  waitForV4CompactMarker,
  waitForV4Pane,
} from "./v4-conversation.js";
import {
  readToolSearchRequests,
  toolSearchBlocks,
  TOOLSEARCH_NOTICE,
  type ToolSearchRecord,
} from "./toolsearch-provider.js";

export const TOOLSEARCH_API_PROVIDER = "toolsearch-api-e2e";
export const TOOLSEARCH_PLAIN_PROVIDER = "toolsearch-anthropic-e2e";
export const TOOLSEARCH_MODEL = "GLM-5.3";

export async function setupToolSearchDesktop() {
  // 匿名隔离 profile 的职业引导仍通过真实 UI 完成。
  await skipOccupationOnboardingIfPresent();
  await prepareV4ConversationE2E({ skipProvider: true });
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      for (const id of [TOOLSEARCH_API_PROVIDER, TOOLSEARCH_PLAIN_PROVIDER]) {
        await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
          id,
          label: id === TOOLSEARCH_API_PROVIDER ? "ToolSearch API" : "ToolSearch Alternate API",
          apiFormat: "anthropic-messages",
          apiKey: "e2e-toolsearch.test-secret",
          baseURL: "https://open.bigmodel.cn/api/anthropic",
          models: [{ id: TOOLSEARCH_MODEL }],
        });
      }
    },
  });
}

export async function newToolSearchTask() {
  // 冷恢复按项目目录读取夹具；全局新建的独立 cwd 不属于该 fixture。
  await prepareV4ConversationE2E({ skipProvider: true });
  await switchV4Model(TOOLSEARCH_API_PROVIDER, TOOLSEARCH_MODEL, "");
}

export async function toolSearchTurn(prompt: string): Promise<ToolSearchRecord[]> {
  const before = (await readToolSearchRequests()).length;
  await sendV4Prompt(prompt);
  await browser.waitUntil(async () => (await readToolSearchRequests()).length > before, {
    timeout: 45_000,
    timeoutMsg: `没有捕获 ${prompt} 的主请求`,
  });
  await waitForV4Pane((s) => !s.canStop, "ToolSearch 轮未结束", 60_000);
  return (await readToolSearchRequests()).slice(before);
}

export async function compactToolSearchTask() {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", { timeout: 15_000 });
  await clickV4Send();
  await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
  await waitForV4Pane((s) => !s.canStop, "compact 未结束", 30_000);
}

export function expectToolSearchLoaded(record: ToolSearchRecord, name = "TodoWrite") {
  expect(record.requestJson.tools?.find((tool) => tool.name === name)?.defer_loading).toBe(true);
  expect(record.requestHeaders["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20");
}

export function expectToolSearchUnloaded(record: ToolSearchRecord, name = "TodoWrite") {
  expect(record.requestJson.tools?.some((tool) => tool.name === name)).toBe(false);
  expect(record.requestJson.tools?.some((tool) => tool.name === "ToolSearch")).toBe(true);
  expect(JSON.stringify(record.requestJson.messages)).not.toContain(`"tool_name":"${name}"`);
}

export function expectToolSearchDisabled(record: ToolSearchRecord) {
  expect(record.requestJson.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
  expect(record.requestJson.tools?.some((tool) => tool.name === "TodoWrite")).toBe(true);
  expect(record.requestJson.tools?.some((tool) => "defer_loading" in tool)).toBe(false);
  expect(record.requestHeaders["anthropic-beta"] ?? "").not.toContain("advanced-tool-use");
  expect(JSON.stringify(record.requestJson.messages)).not.toContain('"type":"tool_reference"');
  expect(JSON.stringify(record.requestJson.messages)).not.toContain(TOOLSEARCH_NOTICE);
}

export function expectOneToolSearchAnnouncement(record: ToolSearchRecord) {
  expect(JSON.stringify(record.requestJson.messages).split(TOOLSEARCH_NOTICE)).toHaveLength(2);
}

export function expectToolResultPair(record: ToolSearchRecord, id: string) {
  const blocks = toolSearchBlocks(record.requestJson);
  expect(blocks.filter((block) => block.type === "tool_use" && block.id === id)).toHaveLength(1);
  expect(
    blocks.filter((block) => block.type === "tool_result" && block.tool_use_id === id),
  ).toHaveLength(1);
}
