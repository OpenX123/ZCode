import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  createProjectId,
  createSessionId,
  type SessionEntryInfo,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

describe("session entry 原子占位", () => {
  it("两个连接同时观察为空后只有一个 writer 获胜，重开后仍保持原始身份和载荷", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-entry-claim-"));
    const dbPath = join(root, "session.sqlite");
    const first = await createSqliteSessionStore({ dbPath });
    let firstClosed = false;
    let second: typeof first | undefined;
    let reopened: typeof first | undefined;
    try {
      second = await createSqliteSessionStore({ dbPath });
      const session = await first.createSession({
        id: createSessionId("claim-source"),
        projectID: createProjectId("claim-source"),
        slug: "claim-source",
        directory: root,
        title: "原子导出",
        version: "0.1.0",
      });
      const other = await first.createSession({
        id: createSessionId("claim-other"),
        projectID: createProjectId("claim-source"),
        slug: "claim-other",
        directory: root,
        title: "另一个会话",
        version: "0.1.0",
      });
      const entry: SessionEntryInfo = {
        id: `${session.id}:fork-export:operation`,
        sessionID: session.id,
        type: "session/fork_export",
        time: { created: session.time.updated + 100, updated: session.time.updated + 100 },
        data: { phase: "nativePending", childId: "winner" },
      };
      const competing = { ...entry, data: { phase: "nativePending", childId: "loser" } };
      await expect(first.sessionEntries({ sessionID: session.id })).resolves.toEqual([]);
      await expect(second.sessionEntries({ sessionID: session.id })).resolves.toEqual([]);

      // 两个连接先读取同一空状态，模拟不同 CLI 的先读后写竞态。
      const claims = await Promise.all([
        first.saveSessionEntryIfAbsent(entry),
        second.saveSessionEntryIfAbsent(competing),
      ]);
      expect(claims).toEqual([true, false]);
      await expect(second.sessionEntries({ sessionID: session.id })).resolves.toEqual([entry]);
      await expect(first.getSession(session.id)).resolves.toMatchObject({
        time: { updated: entry.time.updated },
      });

      await expect(
        second.saveSessionEntryIfAbsent({
          ...competing,
          sessionID: other.id,
          type: "changed-type",
          time: { created: entry.time.created + 100, updated: entry.time.updated + 100 },
        }),
      ).resolves.toBe(false);
      await expect(second.sessionEntries({ sessionID: other.id })).resolves.toEqual([]);
      await expect(second.getSession(other.id)).resolves.toMatchObject({
        time: { updated: other.time.updated },
      });

      first.close();
      firstClosed = true;
      second.close();
      second = undefined;
      reopened = await createSqliteSessionStore({ dbPath });
      await expect(reopened.sessionEntries({ sessionID: session.id })).resolves.toEqual([entry]);
      await expect(reopened.saveSessionEntryIfAbsent(competing)).resolves.toBe(false);
    } finally {
      if (!firstClosed) first.close();
      second?.close();
      reopened?.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("沿用模型选择的存储包装并遵守 touchSession=false", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const session = await store.createSession({
        id: createSessionId("claim-model"),
        projectID: createProjectId("claim-model"),
        slug: "claim-model",
        directory: tmpdir(),
        title: "模型选择",
        version: "0.1.0",
      });
      const entry = {
        id: `${session.id}:selection`,
        sessionID: session.id,
        type: SESSION_ENTRY_MODEL_SELECTION,
        time: { created: session.time.updated + 100, updated: session.time.updated + 100 },
        touchSession: false,
        data: { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "high" } },
      };
      await expect(store.saveSessionEntryIfAbsent(entry)).resolves.toBe(true);
      const { touchSession: _touchSession, ...stored } = entry;
      await expect(store.sessionEntries({ sessionID: session.id })).resolves.toEqual([stored]);
      await expect(store.getSession(session.id)).resolves.toMatchObject({
        time: { updated: session.time.updated },
      });
    } finally {
      store.close();
    }
  });
});
