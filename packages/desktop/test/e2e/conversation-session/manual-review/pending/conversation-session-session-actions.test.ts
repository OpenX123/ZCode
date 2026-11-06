import { TID_WORKSPACE_MORE_BUTTON } from "@zcode/shared/test-ids";
import { parseSessionDeepLink } from "@zcode/shared/session-navigation";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { resolveE2EHomeDir } from "../../../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "../../../helpers/v4-conversation.js";

const runFile = promisify(execFile);

async function activeWorkspacePath(): Promise<string> {
  return await browser.execute(() => {
    const host = window as unknown as {
      __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
    };
    return host.__zcodeTabStoreE2E?.getState().activeWorkspacePath ?? "";
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  // 仅操作隔离 HOME 的真实仓库，去掉调用测试进程继承的 Git 重定向环境。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = await runFile("git", args, { cwd, env });
  return result.stdout.trim();
}

async function seedForkRepository(workspacePath: string) {
  const offset = relative(resolveE2EHomeDir(), resolve(workspacePath));
  if (!offset || offset.startsWith("..") || isAbsolute(offset)) {
    throw new Error("Fork E2E 拒绝操作隔离 HOME 之外的目录");
  }
  await expect(access(join(workspacePath, ".git"))).rejects.toThrow();
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.name", "ZCode E2E"]);
  await git(workspacePath, ["config", "user.email", "zcode-e2e@example.com"]);
  await git(workspacePath, ["config", "commit.gpgsign", "false"]);
  await git(workspacePath, ["config", "core.autocrlf", "false"]);
  await writeFile(join(workspacePath, "fork-tracked.txt"), "base\r\n");
  await git(workspacePath, ["add", "fork-tracked.txt"]);
  await git(workspacePath, ["-c", "core.hooksPath=", "commit", "-m", "seed session fork"]);
  await writeFile(join(workspacePath, "fork-tracked.txt"), "staged\r\n");
  await git(workspacePath, ["add", "fork-tracked.txt"]);
  await writeFile(join(workspacePath, "fork-tracked.txt"), "unstaged\r\n");
  await writeFile(join(workspacePath, "fork-untracked.txt"), "new\r\n");
  return {
    head: await git(workspacePath, ["rev-parse", "HEAD"]),
    index: await readFile(join(workspacePath, ".git", "index")),
  };
}

describe("会话菜单链接与分叉 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("标题菜单复制稳定链接、同目录及新工作树分叉继承历史，且不自动发送输入", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    const sourcePath = await activeWorkspacePath();
    const repository = await seedForkRepository(sourcePath);
    const prompt = `E2E_SESSION_ACTION_${Date.now()}: reply exactly ${E2E_REPLY_TOKEN}.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "首发后输入框未清空");
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    const source = await waitForV4ConversationState(
      (state) =>
        Boolean(state.sessionId || state.taskId) &&
        state.state === "idle" &&
        state.queueCount === 0,
      "源会话未进入空闲状态",
      90000,
    );
    const sourceId = source.sessionId || source.taskId;
    const clipboardBefore = await browser.electron.execute((electron) =>
      electron.clipboard.readText(),
    );
    try {
      await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
      await $('[data-testid="session-copy-link"]').click();
      let copied = "";
      await browser.waitUntil(
        async () => {
          copied = await browser.electron.execute((electron) => electron.clipboard.readText());
          return parseSessionDeepLink(copied)?.taskId === sourceId;
        },
        { timeout: 10000, timeoutMsg: "标题菜单未复制正确会话链接" },
      );
      expect(parseSessionDeepLink(copied)?.workspacePath).toBeTruthy();
      expect(new URL(copied).searchParams.has("remoteSessionId")).toBe(false);

      await $('[data-testid="session-copy-link"]').waitForExist({ reverse: true });
      await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
      await $('[data-testid="session-fork-same-directory"]').waitForDisplayed();
      await $('[data-testid="session-fork-same-directory"]').click();
      const child = await waitForV4ConversationState(
        (state) =>
          Boolean(state.sessionId || state.taskId) &&
          (state.sessionId || state.taskId) !== sourceId,
        "分叉后未打开 child 会话",
        30000,
      );
      expect(child.queueCount).toBe(0);
      await waitForV4ComposerText("", "分叉不得自动提交或填入提示词");
      await waitForV4UserMessageContaining(prompt);
      await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
      expect(await activeWorkspacePath()).toBe(sourcePath);

      const sameDirectoryChildId = child.sessionId || child.taskId;
      await $('[data-testid="session-fork-same-directory"]').waitForExist({ reverse: true });
      await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
      await $('[data-testid="session-fork-worktree"]').waitForDisplayed();
      await $('[data-testid="session-fork-worktree"]').click();
      const worktreeChild = await waitForV4ConversationState(
        (state) =>
          Boolean(state.sessionId || state.taskId) &&
          ![sourceId, sameDirectoryChildId].includes(state.sessionId || state.taskId),
        "新工作树分叉后未打开不同 child 会话",
        45000,
      );
      const worktreePath = await activeWorkspacePath();
      expect(worktreePath).not.toBe(sourcePath);
      expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(repository.head);
      expect(await git(worktreePath, ["branch", "--show-current"])).toMatch(/^ycode\/fork-/);
      expect(await readFile(join(worktreePath, "fork-tracked.txt"), "utf8")).toBe("unstaged\r\n");
      expect(await readFile(join(worktreePath, "fork-untracked.txt"), "utf8")).toBe("new\r\n");
      expect(await readFile(join(sourcePath, ".git", "index"))).toEqual(repository.index);
      expect(await readFile(join(sourcePath, "fork-tracked.txt"), "utf8")).toBe("unstaged\r\n");
      expect(worktreeChild.queueCount).toBe(0);
      await waitForV4ComposerText("", "新工作树分叉不得自动填入或发送提示词");
      await waitForV4UserMessageContaining(prompt);
      await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    } finally {
      await browser.electron.execute(
        (electron, value) => electron.clipboard.writeText(value),
        clipboardBefore,
      );
    }
  });
});
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
