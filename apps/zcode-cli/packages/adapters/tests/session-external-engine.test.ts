import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("会话引擎与官方上下文id持久化，重建记录不改引擎", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-engine-db-"));
  roots.push(root);
  const dbPath = join(root, "session.sqlite");
  const store = await createSqliteSessionStore({ dbPath });
  const id = createSessionId();
  const input = {
    id,
    projectID: createProjectId(),
    slug: "example",
    directory: root,
    title: "example",
    version: "test",
  };
  await store.createSession({ ...input, engine: "codex" });
  await store.updateSession({ id, externalSessionId: "official-thread" });
  await store.createSession({ ...input, engine: "claude-code" });
  expect(await store.getSession(id)).toMatchObject({
    engine: "codex",
    externalSessionId: "official-thread",
  });
  store.close();
  const reopened = await createSqliteSessionStore({ dbPath });
  expect(await reopened.getSession(id)).toMatchObject({
    engine: "codex",
    externalSessionId: "official-thread",
  });
  const legacy = await reopened.createSession({ ...input, id: createSessionId() });
  expect(legacy.engine).toBe("zcode");
  reopened.close();
});
