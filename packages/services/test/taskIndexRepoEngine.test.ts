import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

describe("历史会话客户端身份镜像", () => {
  it("旧行补齐引擎后保留组织态，旧摘要不擦除身份，重开仓库仍可读取", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-task-engine-"));
    setDataBaseDir(dir);
    let repo = new TaskIndexRepo();
    const meta: ZCodeTaskMeta = {
      taskId: "history",
      traceId: "trace",
      title: "历史会话",
      workspacePath: "/repo",
      mode: "default",
      provider: "glm",
      createdAt: 1,
      updatedAt: 2,
    };
    try {
      await repo.applyCliFacts({ meta });
      await repo.updateTaskState({ ...meta, patch: { pinned: true, archived: true } });
      await repo.applyCliFacts({ meta: { ...meta, engine: "codex" } });
      await repo.applyCliFacts({ meta });
      expect((await repo.getTaskMeta(meta))?.engine).toBe("codex");
      repo.close();
      repo = new TaskIndexRepo();
      expect((await repo.getTaskMeta(meta))?.engine).toBe("codex");
      const db = await repo.getOrganizationDatabase();
      const state = db
        .prepare("SELECT pinned, archived FROM tasks WHERE task_id=?")
        .get(meta.taskId);
      expect(state).toMatchObject({ pinned: 1, archived: 1 });
    } finally {
      repo.close();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
