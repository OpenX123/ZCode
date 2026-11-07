// E17（候选，manual-review/pending）：真实 Electron/Host/CLI/双向 stdio；仅原生 adapter 由受控 ACP 夹具替代，
// 回放与 CLI 单测相同的真实形状子智能体帧（Codex AIR 草案、Claude RFD），不使用真实凭据。
// 启动前运行 helpers/external-engine-fixture.mjs <bin>，将该目录置于 PATH 首位并设置
// ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN=<bin>。规则见 docs/desktop/external-agent-engines-spec.md「外部引擎原生子智能体」。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  managedAdapterEntrySegments,
  managedAdapterInstallDirName,
} from "@zcode/shared/external-engine";
import { resolveE2EStorageRoot } from "../../../helpers/e2e-runtime-paths.js";
import {
  getV4FocusedPaneId,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptInPane,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";

const FIXTURES = fileURLToPath(
  new URL(
    "../../../../../../../apps/zcode-cli/packages/bootstrap/tests/fixtures/native-subagents/",
    import.meta.url,
  ),
);

async function installNativeSubagentAdapter(engine: "codex" | "claude-code", frames: string) {
  const bin = process.env.ZCODE_E2E_EXTERNAL_ENGINE_FIXTURE_BIN;
  if (!bin || !process.env.PATH?.split(process.platform === "win32" ? ";" : ":").includes(bin))
    throw new Error("需要隔离的官方 CLI 状态夹具 PATH");
  const descriptor = EXTERNAL_ENGINE_RUNTIMES[engine];
  const root = join(resolveE2EStorageRoot(), "engines", managedAdapterInstallDirName(descriptor));
  const entry = join(root, ...managedAdapterEntrySegments(descriptor));
  await mkdir(dirname(entry), { recursive: true });
  const script = (await readFile(join(FIXTURES, "acp-fixture.cjs"), "utf8"))
    .replace("process.env.FIXTURE_FRAMES", "require('node:path').join(__dirname,'frames.json')")
    .replace(
      "process.env.FIXTURE_LOG",
      "require('node:path').join(__dirname,'client-messages.jsonl')",
    );
  await writeFile(entry, script);
  await writeFile(join(dirname(entry), "frames.json"), await readFile(join(FIXTURES, frames)));
  await writeFile(
    join(root, "node_modules", ...descriptor.adapterPackage.split("/"), "package.json"),
    JSON.stringify({ version: descriptor.adapterVersion }),
  );
}

function persistedChildren(parentSessionId: string) {
  const db = new DatabaseSync(join(resolveE2EStorageRoot(), "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT id, title, task_type AS taskType FROM session WHERE parent_id = ?")
      .all(parentSessionId) as Array<{ id: string; title: string; taskType: string }>;
  } finally {
    db.close();
  }
}

async function displayed(selector: string) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout: 30000 });
  return element;
}

describe("外部引擎原生子智能体（Codex AIR / Claude RFD）", () => {
  it("Codex 原生子智能体落为子会话记录，父会话不混入子会话正文", async () => {
    await installNativeSubagentAdapter("codex", "codex-air.json");
    await startNewV4Draft();
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    const paneId = await getV4FocusedPaneId();
    if (!paneId) throw new Error("缺少当前 pane");
    const paneSelector = `[data-testid="v4-session-pane-${paneId}"]`;
    await (await displayed(`${paneSelector} [data-testid="session-engine-select"]`)).click();
    await $('[role="option"]=Codex').click();
    await sendV4PromptInPane(paneId, "检查鉴权性能");
    await waitForV4AssistantMessageContaining("子智能体已完成。");
    const parentId = (await getV4PaneSnapshot()).sessionId;
    if (!parentId) throw new Error("缺少父会话 ID");
    const children = persistedChildren(parentId);
    expect(children.map((child) => child.taskType)).toEqual(["subagent_child", "subagent_child"]);
    expect(children.map((child) => child.title)).toContain("Engine perf auth");
    // 子会话正文只进子会话；父会话可见正文不含子会话回答。
    expect(await $(paneSelector).getText()).not.toContain("鉴权耗时集中在 checkAuth");
  });
});
