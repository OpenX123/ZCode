import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// docs/desktop/host-idle-resources-1.1-spec.md §5：Host 启动关键路径分阶段 info 打点（无路径、无正文）。

const fixtures = vi.hoisted(() => ({ host: vi.fn(), session: vi.fn(), mark: vi.fn() }));
vi.mock("@zcode/services/storage-startup", () => ({
  getTasksIndexDatabasePath: () => "/isolated/v2/tasks.sqlite",
  resolveZCodeAgentSpawnCwd: async (...args: unknown[]) =>
    (
      await import("../../services/src/zcode-agent/zcodeAgentSpawnCwd.js")
    ).resolveZCodeAgentSpawnCwd(...(args as [never])),
  markTasksStoragePrepared: fixtures.mark,
}));
vi.mock("../src/host/database-startup/storagePreparationProcesses.js", () => ({
  prepareHostStorage: fixtures.host,
  prepareSessionStorage: fixtures.session,
}));
import { createHostDatabaseStartup } from "../src/host/database-startup/hostDatabaseStartup.js";

it("每个阶段完成时写一条只含毫秒与枚举的 info，并给会话库准备 Worker 指定编译缓存目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-timing-"));
  fixtures.host.mockResolvedValue(undefined);
  fixtures.session.mockResolvedValue({
    workerLoadMs: 640,
    observeMs: 3,
    prepareMs: 20,
    exitMs: 5,
    reuse: false,
    compileCache: "enabled",
  });
  const stages: Array<{ stage: string; fields: Record<string, unknown> }> = [];
  const startup = createHostDatabaseStartup({
    cwd: tmpdir(),
    workingDirectories: [dir],
    initializeServices: async () => {},
    publish: () => {},
    onFailure: () => {},
    logStage: (stage, fields) => stages.push({ stage, fields }),
  });
  try {
    await startup.coordinator.start();
    expect(stages.map((entry) => entry.stage)).toEqual([
      "tasks_baseline",
      "tasks_index",
      "session_cwd",
      "session_storage",
      "services_init",
      "completed",
    ]);
    expect(stages.find((entry) => entry.stage === "session_storage")?.fields).toMatchObject({
      workerLoadMs: 640,
      reuse: false,
      compileCache: "enabled",
    });
    for (const { fields } of stages) {
      for (const value of Object.values(fields)) {
        // 只允许数字、布尔与短枚举：路径、正文不得进入启动日志。
        if (typeof value === "string") expect(value).toMatch(/^[a-z_]+$/);
        else expect(["number", "boolean"]).toContain(typeof value);
      }
      expect(fields.durationMs ?? fields.totalMs).toEqual(expect.any(Number));
    }
    expect(fixtures.session).toHaveBeenCalledWith(
      expect.objectContaining({
        compileCacheDir: join("/isolated/v2", "cache", "node-compile-cache"),
      }),
    );
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("失败时写 failed 汇总，不含错误正文", async () => {
  fixtures.host.mockRejectedValue(new Error("secret path C:\\Users\\someone\\db"));
  const stages: Array<{ stage: string; fields: Record<string, unknown> }> = [];
  const startup = createHostDatabaseStartup({
    cwd: tmpdir(),
    initializeServices: async () => {},
    publish: () => {},
    onFailure: () => {},
    logStage: (stage, fields) => stages.push({ stage, fields }),
  });
  try {
    await startup.coordinator.start();
    const failed = stages.find((entry) => entry.stage === "failed");
    expect(failed?.fields).toMatchObject({
      failedStage: "tasks_index",
      totalMs: expect.any(Number),
    });
    expect(JSON.stringify(stages)).not.toContain("secret");
  } finally {
    startup.dispose();
  }
});
