import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotsStateFile, ZCodeStreamEvent } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import { BotsRepo } from "../src/bots/repo.js";
import { setDataBaseDir } from "../src/paths.js";
import * as f from "./botsService.fixtures.js";

// docs/desktop/host-idle-resources-1.1-spec.md §1：Bot 状态只读路径不加文件锁，私聊恢复轮询只在需要时运行。

const services: ReturnType<typeof f.createBotsService>[] = [];
let tempDir: string | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-bots-read-path-"));
  setDataBaseDir(tempDir);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.disposeAllAndWait();
  setDataBaseDir(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function stateFilePath(): string {
  return join(tempDir!, ".zcode", "v2", "bot-state.v3.json");
}

const privateTaskState = (workspaceIdentity?: string): BotsStateFile => ({
  version: 3,
  bots: {
    "telegram-1": {
      botId: "telegram-1",
      mode: "task",
      activeTaskId: "task-1",
      workspacePath: "/tmp/workspace",
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      updatedAt: 1,
    },
  },
});

function countingRepo(state: BotsStateFile) {
  const base = f.createMemoryRepo(f.telegramConfig, state);
  const readState = vi.fn(base.readState);
  const readStateSnapshot = vi.fn(base.readState);
  return {
    ...base,
    readState,
    readStateSnapshot,
    reads: () => readState.mock.calls.length + readStateSnapshot.mock.calls.length,
  };
}

describe("BotsRepo.readStateSnapshot", () => {
  it("BOT04: 文件锁被占用时只读快照不等待锁", async () => {
    const repo = new BotsRepo();
    await repo.writeState(privateTaskState());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = withFileLock(stateFilePath(), async () => {
      acquired();
      await held;
    });
    await lockAcquired;
    try {
      const service = f.createBotsService({
        repo,
        runStartupBackgroundTasks: false,
      });
      services.push(service);
      // 修复前 getBotStates 与写入排在同一把文件锁上（实测 12 个并发 0.2→1.9s 阶梯），
      // 这里锁一直不释放：只读路径必须直接读到已原子替换的完整文件。
      const outcome = await Promise.race([
        service.getBotStates(),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);
      expect(outcome).toEqual([expect.objectContaining({ botId: "telegram-1", mode: "task" })]);
    } finally {
      release();
      await holder;
    }
  });

  it("BOT05: v3 不存在时经加锁迁移写出 v3", async () => {
    const dataDir = join(tempDir!, ".zcode", "v2");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "bot-state.json"),
      `${JSON.stringify({
        version: 2,
        bots: {
          "telegram-1": {
            botId: "telegram-1",
            workspacePath: "/tmp/workspace",
            mode: "task",
            activeTaskId: "task-1",
            updatedAt: 1,
          },
        },
      })}\n`,
    );
    const repo = new BotsRepo();
    await expect(repo.readStateSnapshot()).resolves.toMatchObject({
      bots: { "telegram-1": { activeTaskId: "task-1" } },
    });
    expect(existsSync(stateFilePath())).toBe(true);
    expect(JSON.parse(readFileSync(stateFilePath(), "utf8"))).toMatchObject({ version: 3 });
  });

  it("没有机器人时 getBotStates 快速返回空且不创建锁目录", async () => {
    const repo = new BotsRepo();
    await repo.writeState({ version: 3, bots: {} });
    const service = f.createBotsService({ repo, runStartupBackgroundTasks: false });
    services.push(service);
    await expect(service.getBotStates()).resolves.toEqual([]);
    expect(existsSync(`${stateFilePath()}.lock`)).toBe(false);
  });
});

describe("私聊恢复轮询只在需要时运行", () => {
  it("BOT01: 没有机器人上下文时启动后不再读取状态文件", async () => {
    vi.useFakeTimers();
    const repo = countingRepo({ version: 3, bots: {} });
    const service = f.createBotsService({
      repo: repo as never,
      credentialService: f.createCredentialService(),
    });
    services.push(service);
    await vi.advanceTimersByTimeAsync(1_000);
    const afterStartup = repo.reads();
    // 修复前每 10 秒无条件对 bot-state.v3.json 走一次完整文件锁读取。
    await vi.advanceTimersByTimeAsync(35_000);
    expect(repo.reads()).toBe(afterStartup);
  });

  it("BOT02: 远端私聊上下文在连接恢复后由轮询恢复订阅", async () => {
    vi.useFakeTimers();
    const repo = countingRepo(privateTaskState("remote:server:test-owner:/tmp/workspace"));
    let connected = false;
    const tasks = f.createLegacyTaskService();
    const subscribe = vi.fn(
      () => (_listener: (event: ZCodeStreamEvent) => Promise<void> | void) => ({
        dispose: vi.fn(),
      }),
    );
    Object.assign(tasks, { onDynamicTaskEvent: subscribe });
    const service = f.createBotsService({
      repo: repo as never,
      legacyTaskService: tasks,
      credentialService: f.createCredentialService(),
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => connected),
        ensureConnected: vi.fn(async () => ({ ok: true as const })),
        getZCodeTaskService: vi.fn(async () => tasks),
        getModelSelectionService: vi.fn(async () =>
          f.createModelSelectionService([{ id: "glm", name: "GLM", models: ["default"] }]),
        ),
      },
    });
    services.push(service);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscribe).not.toHaveBeenCalled();
    connected = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("BOT03: 私聊上下文重置后停止轮询", async () => {
    vi.useFakeTimers();
    const repo = countingRepo(privateTaskState());
    const tasks = f.createLegacyTaskService();
    Object.assign(tasks, {
      onDynamicTaskEvent: vi.fn(
        () => (_listener: (event: ZCodeStreamEvent) => Promise<void> | void) => ({
          dispose: vi.fn(),
        }),
      ),
    });
    const service = f.createBotsService({
      repo: repo as never,
      legacyTaskService: tasks,
      credentialService: f.createCredentialService(),
    });
    services.push(service);
    await vi.advanceTimersByTimeAsync(1_000);
    await service.resetBotState("telegram-1");
    // 下一次扫描发现没有任务态私聊上下文、没有订阅 → 停表。
    await vi.advanceTimersByTimeAsync(10_000);
    const afterStop = repo.reads();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repo.reads()).toBe(afterStop);
  });
});
