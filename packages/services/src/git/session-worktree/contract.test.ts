import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitService } from "../gitService.js";
import { getGitCommandEnv } from "../config.js";
import { setDataBaseDir } from "../../paths.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const dirs: string[] = [];
const operationId = "test-fork-12345678";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: getGitCommandEnv() }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-fork-worktree-"));
  dirs.push(root);
  const repo = join(root, "source");
  const workspacePath = join(repo, "目录 with spaces");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await writeFile(join(workspacePath, "tracked.txt"), "base\r\n");
  await writeFile(join(workspacePath, "delete.txt"), "delete\n");
  await writeFile(join(workspacePath, "rename.txt"), "rename\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 255, 4]));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "ZCode Tester"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  setDataBaseDir(join(root, "data"));
  return { repo, workspacePath };
}

afterEach(async () => {
  setDataBaseDir(null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!gitAvailable)("Git 会话工作树", () => {
  it("只读查询不创建记录，重建服务后恢复 ready，且不将中断或已回滚操作当作已准备", async () => {
    const { repo } = await fixture();
    const request = { workspacePath: repo, operationId };
    expect(await createGitService().getSessionWorktreePreparation(request)).toBeUndefined();
    await expect(access(join(dirname(repo), "data", ".zcode", "worktrees"))).rejects.toThrow();
    const result = await createGitService().prepareSessionWorktree(request);
    const recordPath = join(dirname(result.worktreeRoot), ".operations", `${operationId}.json`);
    const before = await readFile(recordPath, "utf8");
    await writeFile(join(repo, "binary.bin"), "later source edit");
    expect(await createGitService().getSessionWorktreePreparation(request)).toEqual(result);
    expect(await readFile(recordPath, "utf8")).toBe(before);
    const record = JSON.parse(before);
    await writeFile(recordPath, JSON.stringify({ ...record, phase: "creating" }));
    expect(await createGitService().getSessionWorktreePreparation(request)).toBeUndefined();
    await writeFile(recordPath, before);
    expect(await createGitService().rollbackSessionWorktree(request)).toEqual({ removed: true });
    expect(await createGitService().getSessionWorktreePreparation(request)).toBeUndefined();
  }, 30_000);

  it("保留原 HEAD 祖先、原始字节、删除与重命名，源 index 完全不变", async () => {
    const { repo, workspacePath } = await fixture();
    await writeFile(join(workspacePath, "tracked.txt"), "staged\r\n");
    git(repo, ["add", "."]);
    await writeFile(join(workspacePath, "tracked.txt"), "unstaged\r\n");
    await rm(join(workspacePath, "delete.txt"));
    await rename(join(workspacePath, "rename.txt"), join(workspacePath, "重命名.txt"));
    await writeFile(join(workspacePath, "新建.txt"), "new\r\n");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 9, 255, 7]));
    await mkdir(join(repo, "ignored"));
    await writeFile(join(repo, "ignored", "secret"), "private");
    const sourceIndex = await readFile(join(repo, ".git", "index"));
    const sourceStatus = git(repo, ["status", "--porcelain=v1", "-uall"]);
    const sourceHead = git(repo, ["rev-parse", "HEAD"]);
    const result = await createGitService().prepareSessionWorktree({ workspacePath, operationId });
    expect(result.workspacePath).toBe(join(result.worktreeRoot, "目录 with spaces"));
    expect(result.headOid).toBe(sourceHead);
    expect(git(result.worktreeRoot, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(git(result.worktreeRoot, ["branch", "--show-current"])).toBe(result.branchName);
    expect(await readFile(join(result.workspacePath, "tracked.txt"), "utf8")).toBe("unstaged\r\n");
    expect(await readFile(join(result.workspacePath, "新建.txt"), "utf8")).toBe("new\r\n");
    expect(await readFile(join(result.worktreeRoot, "binary.bin"))).toEqual(
      Buffer.from([0, 9, 255, 7]),
    );
    await expect(access(join(result.workspacePath, "delete.txt"))).rejects.toThrow();
    await expect(access(join(result.workspacePath, "rename.txt"))).rejects.toThrow();
    await expect(access(join(result.worktreeRoot, "ignored", "secret"))).rejects.toThrow();
    expect(await readFile(join(result.workspacePath, "重命名.txt"), "utf8")).toBe("rename\n");
    expect(git(result.worktreeRoot, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await readFile(join(repo, ".git", "index"))).toEqual(sourceIndex);
    expect(git(repo, ["status", "--porcelain=v1", "-uall"])).toBe(sourceStatus);
  }, 30_000);

  it("并发、重建服务与 linked worktree 源均复用同一操作，回滚幂等", async () => {
    const { repo } = await fixture();
    const linked = join(repo, "..", "linked");
    git(repo, ["worktree", "add", "-b", "linked", linked]);
    const request = { workspacePath: linked, operationId };
    const [first, second] = await Promise.all([
      createGitService().prepareSessionWorktree(request),
      createGitService().prepareSessionWorktree(request),
    ]);
    expect(second).toEqual(first);
    expect(await createGitService().prepareSessionWorktree(request)).toEqual(first);
    expect(await createGitService().rollbackSessionWorktree(request)).toEqual({ removed: true });
    await expect(access(first.worktreeRoot)).rejects.toThrow();
    expect(git(repo, ["branch", "--list", first.branchName])).toBe("");
    expect(await createGitService().rollbackSessionWorktree(request)).toEqual({
      removed: false,
      reason: "not-found",
    });
    await expect(createGitService().prepareSessionWorktree(request)).rejects.toThrow(
      /rolled back/i,
    );
  }, 30_000);

  it.each(["content", "ignored", "index", "commit"])(
    "回滚保护用户变更：%s",
    async (kind) => {
      const { repo } = await fixture();
      const request = { workspacePath: repo, operationId };
      const result = await createGitService().prepareSessionWorktree(request);
      if (kind === "ignored") {
        await mkdir(join(result.worktreeRoot, "ignored"));
        await writeFile(join(result.worktreeRoot, "ignored", "private.env"), "user data");
      } else if (kind === "index") {
        git(result.worktreeRoot, ["rm", "--cached", "binary.bin"]);
      } else if (kind === "commit") {
        git(result.worktreeRoot, ["commit", "--allow-empty", "-m", "child"]);
      } else {
        await writeFile(join(result.worktreeRoot, "binary.bin"), "user changed");
      }
      expect(await createGitService().rollbackSessionWorktree(request)).toEqual({
        removed: false,
        reason: "modified",
      });
      await access(result.worktreeRoot);
    },
    30_000,
  );

  it("拒绝目录穿越、非仓库、子模块或嵌套仓库", async () => {
    const { repo } = await fixture();
    await expect(
      createGitService().prepareSessionWorktree({ workspacePath: repo, operationId: "../escape" }),
    ).rejects.toThrow(/operationId/i);
    await expect(
      createGitService().prepareSessionWorktree({ workspacePath: tmpdir(), operationId }),
    ).rejects.toThrow(/repository/i);
    const nested = join(repo, "nested");
    await mkdir(nested);
    git(nested, ["init"]);
    await writeFile(join(nested, "hello"), "nested");
    await expect(
      createGitService().prepareSessionWorktree({ workspacePath: repo, operationId }),
    ).rejects.toThrow(/nested|submodule/i);
    await rm(nested, { recursive: true, force: true });
    git(repo, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(repo, ["rev-parse", "HEAD"])},module`,
    ]);
    await expect(
      createGitService().prepareSessionWorktree({
        workspacePath: repo,
        operationId: "submodule-12345678",
      }),
    ).rejects.toThrow(/submodule/i);
  }, 30_000);

  it("完整快照阶段中断可复用；中断后用户暂存不得覆盖", async () => {
    const { repo } = await fixture();
    const request = { workspacePath: repo, operationId };
    const result = await createGitService().prepareSessionWorktree(request);
    const recordPath = join(dirname(result.worktreeRoot), ".operations", `${operationId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.phase = "creating";
    await writeFile(recordPath, JSON.stringify(record));
    expect(await createGitService().prepareSessionWorktree(request)).toEqual(result);
    record.phase = "creating";
    await writeFile(recordPath, JSON.stringify(record));
    git(result.worktreeRoot, ["rm", "--cached", "binary.bin"]);
    await expect(createGitService().prepareSessionWorktree(request)).rejects.toThrow(
      /modified.*preserving/i,
    );
    await access(result.worktreeRoot);
  }, 30_000);

  it("回滚删除目录后中断可继续安全删除原分支", async () => {
    const { repo } = await fixture();
    const request = { workspacePath: repo, operationId };
    const result = await createGitService().prepareSessionWorktree(request);
    const recordPath = join(dirname(result.worktreeRoot), ".operations", `${operationId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.phase = "removing";
    await writeFile(recordPath, JSON.stringify(record));
    git(repo, ["worktree", "remove", "--force", result.worktreeRoot]);
    expect(await createGitService().rollbackSessionWorktree(request)).toEqual({ removed: true });
    expect(git(repo, ["branch", "--list", result.branchName])).toBe("");
  }, 30_000);
});
