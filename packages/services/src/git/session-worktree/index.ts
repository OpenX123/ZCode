import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  GitSessionWorktreeRequest,
  GitSessionWorktreeResult,
  GitSessionWorktreeRollbackResult,
} from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { getZCodeDataRootDir } from "../../paths.js";
import { createGitCommandProvider } from "../providers/gitCommandProvider.js";
import type { GitCliRepo } from "../repo/gitCliTypes.js";
import type { GitSessionWorktreeManager } from "./contract.js";

interface OperationRecord {
  result: GitSessionWorktreeResult;
  sourceWorkspacePath: string;
  repoRoot: string;
  phase: "snapshot" | "creating" | "ready" | "removing" | "removed";
  snapshotFingerprint: string;
  expectedFingerprint?: string;
  expectedIndex?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return (
    offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
  );
}

function safePath(root: string, path: string): string {
  const target = resolve(root, path);
  if (!inside(root, target) || path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
    throw new Error("Unsafe path in repository snapshot");
  }
  return target;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory)).sort();
    for (const entry of entries) {
      if (!prefix && entry === ".git") continue;
      const path = join(directory, entry);
      const key = prefix ? `${prefix}/${entry}` : entry;
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([key, "directory"]));
        await visit(path, key);
      } else if (stat.isSymbolicLink()) {
        hash.update(JSON.stringify([key, "symlink", await readlink(path)]));
      } else if (stat.isFile()) {
        hash.update(JSON.stringify([key, "file", stat.mode & 0o111, await fileHash(path)]));
      } else {
        throw new Error("Special files cannot be copied into a session worktree");
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

export function createGitSessionWorktreeManager(
  repo: Pick<GitCliRepo, "resolveRepository">,
): GitSessionWorktreeManager {
  const commands = createGitCommandProvider();
  async function git(cwd: string, args: string[]): Promise<string> {
    const result = await commands.run({ cwd, args, maxOutputBytes: 32 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(result.stderr.trim() || "Git session worktree command failed");
    }
    return result.stdout;
  }

  async function context(request: GitSessionWorktreeRequest) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(request.operationId)) {
      throw new Error("Invalid session worktree operationId");
    }
    const resolution = await repo.resolveRepository(request.workspacePath);
    if (!resolution.isRepository || !resolution.isGitAvailable) {
      throw new Error("Session worktrees require a Git repository");
    }
    const repoRoot = await realpath(resolution.repoRoot);
    const sourceWorkspacePath = await realpath(request.workspacePath);
    if (!inside(repoRoot, sourceWorkspacePath))
      throw new Error("Workspace is outside its repository");
    const commonDir = await realpath(
      resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim()),
    );
    const repoKey = process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
    const repoHash = createHash("sha256").update(repoKey).digest("hex").slice(0, 24);
    const root = join(getZCodeDataRootDir(), "worktrees", repoHash);
    if (inside(repoRoot, root))
      throw new Error("Session worktree storage must be outside the source repository");
    const metadata = join(root, ".operations");
    const recordPath = join(metadata, `${request.operationId}.json`);
    const snapshot = join(metadata, `${request.operationId}.snapshot`);
    const worktreeRoot = join(root, request.operationId);
    const branchName = `ycode/fork-${request.operationId}`;
    async function read(): Promise<OperationRecord | null> {
      if (!(await exists(recordPath))) return null;
      const record = JSON.parse(await readFile(recordPath, "utf8")) as OperationRecord;
      if (
        record.sourceWorkspacePath !== sourceWorkspacePath ||
        record.repoRoot !== repoRoot ||
        record.result.operationId !== request.operationId ||
        record.result.worktreeRoot !== worktreeRoot ||
        record.result.branchName !== branchName
      ) {
        throw new Error("Session worktree operation belongs to another source");
      }
      return record;
    }
    async function write(record: OperationRecord): Promise<void> {
      await atomicWritePrivateTextFile(recordPath, JSON.stringify(record));
    }
    return {
      repoRoot,
      sourceWorkspacePath,
      worktreeRoot,
      branchName,
      snapshot,
      recordPath,
      read,
      write,
    };
  }

  async function listSource(repoRoot: string, headOid: string): Promise<string[]> {
    if ((await git(repoRoot, ["ls-files", "--unmerged", "-z"])).length > 0) {
      throw new Error("Resolve Git conflicts before creating a session worktree");
    }
    const staged = await git(repoRoot, ["ls-files", "--stage", "-z"]);
    const head = await git(repoRoot, ["ls-tree", "-r", "-z", headOid]);
    if (
      staged.split("\0").some((line) => line.startsWith("160000 ")) ||
      head.split("\0").some((line) => line.startsWith("160000 "))
    ) {
      throw new Error("Submodule repositories cannot be copied into a session worktree");
    }
    const paths = new Set(
      (await git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean),
    );
    for (const line of head.split("\0").filter(Boolean))
      paths.add(line.slice(line.indexOf("\t") + 1));
    return [...paths].sort();
  }

  async function copySnapshot(repoRoot: string, snapshot: string, paths: string[]): Promise<void> {
    await mkdir(snapshot, { recursive: true });
    for (const path of paths) {
      const source = safePath(repoRoot, path);
      let parent = dirname(source);
      let hasSymlinkParent = false;
      while (parent !== repoRoot && inside(repoRoot, parent)) {
        if (await exists(parent)) {
          const stat = await lstat(parent);
          if (!stat.isDirectory()) hasSymlinkParent = true;
          if (stat.isDirectory() && (await exists(join(parent, ".git"))))
            throw new Error("Nested repositories cannot be copied into a session worktree");
        }
        parent = dirname(parent);
      }
      if (hasSymlinkParent || !(await exists(source))) continue;
      const stat = await lstat(source);
      if (stat.isDirectory()) {
        if (await exists(join(source, ".git")))
          throw new Error("Nested repositories cannot be copied into a session worktree");
        continue;
      }
      const target = safePath(snapshot, path);
      await mkdir(dirname(target), { recursive: true });
      if (stat.isSymbolicLink()) {
        await symlink(await readlink(source), target);
      } else if (stat.isFile()) {
        await copyFile(source, target);
        await chmod(target, stat.mode & 0o777);
      } else {
        throw new Error("Special files cannot be copied into a session worktree");
      }
    }
  }

  async function applySnapshot(snapshot: string, target: string): Promise<void> {
    // 目标刚由本操作创建且尚未交给会话；先移除 checkout 内容，避免文件／目录类型变化遗留旧文件。
    for (const entry of await readdir(target)) {
      if (entry !== ".git") await rm(join(target, entry), { recursive: true, force: true });
    }
    async function copy(directory: string, destination: string): Promise<void> {
      for (const entry of await readdir(directory)) {
        const source = join(directory, entry);
        const output = join(destination, entry);
        const stat = await lstat(source);
        if (stat.isDirectory()) {
          await mkdir(output);
          await copy(source, output);
        } else if (stat.isSymbolicLink()) {
          await symlink(await readlink(source), output);
        } else {
          await copyFile(source, output);
          await chmod(output, stat.mode & 0o777);
        }
      }
    }
    await copy(snapshot, target);
  }

  return {
    async getPreparation(request: GitSessionWorktreeRequest) {
      const ctx = await context(request);
      // 原子记录替换保证只读查询不会看到半写入数据；不取写锁，避免查询创建目录或锁文件。
      const record = await ctx.read();
      return record?.phase === "ready" && (await exists(ctx.worktreeRoot))
        ? record.result
        : undefined;
    },

    async prepare(request: GitSessionWorktreeRequest): Promise<GitSessionWorktreeResult> {
      const ctx = await context(request);
      return await withFileLock(ctx.recordPath, async () => {
        let record = await ctx.read();
        if (record?.phase === "removed" || record?.phase === "removing")
          throw new Error("Session worktree operation was rolled back");
        if (record?.phase === "ready") {
          if (!(await exists(ctx.worktreeRoot)))
            throw new Error("Prepared session worktree no longer exists");
          return record.result;
        }
        if (!record) {
          if (await exists(ctx.worktreeRoot))
            throw new Error("Session worktree destination already exists");
          const headOid = (await git(ctx.repoRoot, ["rev-parse", "--verify", "HEAD"])).trim();
          const branch = await commands.run({
            cwd: ctx.repoRoot,
            args: ["show-ref", "--verify", `refs/heads/${ctx.branchName}`],
          });
          if (branch.exitCode === 0) throw new Error("Session worktree branch already exists");
          await rm(ctx.snapshot, { recursive: true, force: true });
          const paths = await listSource(ctx.repoRoot, headOid);
          const indexBefore = await git(ctx.repoRoot, ["ls-files", "--stage", "-z"]);
          await copySnapshot(ctx.repoRoot, ctx.snapshot, paths);
          await mkdir(join(ctx.snapshot, relative(ctx.repoRoot, ctx.sourceWorkspacePath)), {
            recursive: true,
          });
          const snapshotFingerprint = await fingerprint(ctx.snapshot);
          const verification = `${ctx.snapshot}.verify`;
          try {
            await rm(verification, { recursive: true, force: true });
            const afterPaths = await listSource(ctx.repoRoot, headOid);
            await copySnapshot(ctx.repoRoot, verification, afterPaths);
            await mkdir(join(verification, relative(ctx.repoRoot, ctx.sourceWorkspacePath)), {
              recursive: true,
            });
            if (
              JSON.stringify(paths) !== JSON.stringify(afterPaths) ||
              snapshotFingerprint !== (await fingerprint(verification)) ||
              headOid !== (await git(ctx.repoRoot, ["rev-parse", "HEAD"])).trim() ||
              indexBefore !== (await git(ctx.repoRoot, ["ls-files", "--stage", "-z"]))
            ) {
              throw new Error(
                "Source repository changed while preparing its snapshot; retry when idle",
              );
            }
          } finally {
            await rm(verification, { recursive: true, force: true });
          }
          record = {
            sourceWorkspacePath: ctx.sourceWorkspacePath,
            repoRoot: ctx.repoRoot,
            phase: "snapshot",
            snapshotFingerprint,
            result: {
              operationId: request.operationId,
              worktreeRoot: ctx.worktreeRoot,
              workspacePath: join(
                ctx.worktreeRoot,
                relative(ctx.repoRoot, ctx.sourceWorkspacePath),
              ),
              branchName: ctx.branchName,
              headOid,
            },
          };
          await ctx.write(record);
        }
        if (await exists(ctx.worktreeRoot)) {
          const targetHead = (await git(ctx.worktreeRoot, ["rev-parse", "HEAD"])).trim();
          const targetBranch = (await git(ctx.worktreeRoot, ["branch", "--show-current"])).trim();
          const changedIndex = (
            await git(ctx.worktreeRoot, [
              "diff",
              "--cached",
              "--name-only",
              "--no-ext-diff",
              record.result.headOid,
              "--",
            ])
          ).trim();
          if (
            targetHead !== record.result.headOid ||
            targetBranch !== ctx.branchName ||
            changedIndex
          )
            throw new Error("Interrupted session worktree has been modified; preserving it");
          const complete = (await fingerprint(ctx.worktreeRoot)) === record.snapshotFingerprint;
          const clean =
            (
              await git(ctx.worktreeRoot, [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignored",
              ])
            ).trim() === "";
          if (!complete && !clean)
            throw new Error("Interrupted session worktree has been modified; preserving it");
          if (!complete) await applySnapshot(ctx.snapshot, ctx.worktreeRoot);
        } else {
          record.phase = "creating";
          await ctx.write(record);
          // 禁止 post-checkout hook：分叉准备不运行仓库代码或安装依赖。
          await git(ctx.repoRoot, [
            "-c",
            "core.hooksPath=",
            "worktree",
            "add",
            "-b",
            ctx.branchName,
            ctx.worktreeRoot,
            record.result.headOid,
          ]);
          await applySnapshot(ctx.snapshot, ctx.worktreeRoot);
        }
        record.expectedFingerprint = await fingerprint(ctx.worktreeRoot);
        record.expectedIndex = await git(ctx.worktreeRoot, ["ls-files", "--stage", "-v", "-z"]);
        record.phase = "ready";
        await ctx.write(record);
        await rm(ctx.snapshot, { recursive: true, force: true });
        return record.result;
      });
    },

    async rollback(request: GitSessionWorktreeRequest): Promise<GitSessionWorktreeRollbackResult> {
      const ctx = await context(request);
      return await withFileLock(ctx.recordPath, async () => {
        const record = await ctx.read();
        if (!record || record.phase === "removed") return { removed: false, reason: "not-found" };
        if (!(await exists(ctx.worktreeRoot))) {
          if (record.phase !== "removing") return { removed: false, reason: "not-found" };
          await git(ctx.repoRoot, [
            "update-ref",
            "-d",
            `refs/heads/${ctx.branchName}`,
            record.result.headOid,
          ]);
          record.phase = "removed";
          await ctx.write(record);
          return { removed: true };
        }
        try {
          if (
            (record.phase !== "ready" && record.phase !== "removing") ||
            (await git(ctx.worktreeRoot, ["rev-parse", "HEAD"])).trim() !== record.result.headOid ||
            (await git(ctx.worktreeRoot, ["branch", "--show-current"])).trim() !== ctx.branchName ||
            (await fingerprint(ctx.worktreeRoot)) !== record.expectedFingerprint ||
            (await git(ctx.worktreeRoot, ["ls-files", "--stage", "-v", "-z"])) !==
              record.expectedIndex
          ) {
            return { removed: false, reason: "modified" };
          }
        } catch {
          return { removed: false, reason: "modified" };
        }
        record.phase = "removing";
        await ctx.write(record);
        await git(ctx.repoRoot, ["worktree", "remove", "--force", ctx.worktreeRoot]);
        await git(ctx.repoRoot, [
          "update-ref",
          "-d",
          `refs/heads/${ctx.branchName}`,
          record.result.headOid,
        ]);
        record.phase = "removed";
        await ctx.write(record);
        await rm(ctx.snapshot, { recursive: true, force: true });
        return { removed: true };
      });
    },
  };
}
