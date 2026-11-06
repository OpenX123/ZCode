import { afterEach, describe, expect, it } from "vitest";
import type { ForkCommitBundle } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import {
  CHILD_ID,
  PARENT_ID,
  forkBundle,
  messageInput,
  sessionInput,
} from "./fixtures/session-transaction-race.js";

const stores: Awaited<ReturnType<typeof createSqliteSessionStore>>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function fixture() {
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  stores.push(store);
  await store.createSession(sessionInput(PARENT_ID, "/source"));
  const original = messageInput(PARENT_ID);
  await store.saveMessage(original.info);
  await store.savePart(original.parts[0]!);
  await store.saveSessionEntry({
    id: "existing-entry",
    sessionID: PARENT_ID,
    type: "source-marker",
    time: { created: 1, updated: 1 },
    data: { source: true },
  });
  await store.saveSessionInput({
    id: "existing-input",
    sessionID: PARENT_ID,
    kind: "sendText",
    delivery: "queue",
    payload: { text: "源输入" },
  });
  const bundle = forkBundle("/target");
  bundle.commandFact.scope = "child";
  return { store, original, bundle };
}

describe("Fork bundle 全库身份完整性", () => {
  it.each(["message", "part", "entry", "input", "command-fact"] as const)(
    "拒绝占用既有%s主键且完整保留源数据",
    async (kind) => {
      const { store, original, bundle } = await fixture();
      if (kind === "message") {
        bundle.messages[0]!.info.id = original.info.id;
        bundle.messages[0]!.parts[0]!.messageID = original.info.id;
      } else if (kind === "part") bundle.messages[0]!.parts[0]!.id = original.parts[0]!.id;
      else if (kind === "entry")
        bundle.entries.push({
          id: "existing-entry",
          sessionID: CHILD_ID,
          type: "replacement",
          time: { created: 2, updated: 2 },
          data: { source: false },
        });
      else if (kind === "input")
        bundle.initialInput = {
          id: "existing-input",
          sessionID: CHILD_ID,
          kind: "sendText",
          delivery: "startNow",
          payload: { text: "替换输入" },
        };
      else
        await store.saveSessionEntry({
          id: `v4_command_fact:child:${PARENT_ID}:${bundle.commandFact.sourceCommandId}`,
          sessionID: PARENT_ID,
          type: "source-marker",
          time: { created: 1, updated: 1 },
          data: { source: true },
        });
      const sourceBefore = {
        session: await store.getSession(PARENT_ID),
        messages: await store.messages({ sessionID: PARENT_ID }),
        entries: await store.sessionEntries({ sessionID: PARENT_ID }),
        inputs: await store.listSessionInputs({ sessionID: PARENT_ID }),
      };
      await expect(store.commitForkBundle(bundle)).rejects.toThrow(/conflict|already exists/i);
      expect(await store.getSession(CHILD_ID)).toBeNull();
      expect({
        session: await store.getSession(PARENT_ID),
        messages: await store.messages({ sessionID: PARENT_ID }),
        entries: await store.sessionEntries({ sessionID: PARENT_ID }),
        inputs: await store.listSessionInputs({ sessionID: PARENT_ID }),
      }).toEqual(sourceBefore);
    },
  );

  it.each(["message", "part", "entry", "reserved-command-entry"] as const)(
    "拒绝bundle内部重复的%s主键",
    async (kind) => {
      const { store, bundle } = await fixture();
      if (kind === "message") bundle.messages.push(structuredClone(bundle.messages[0]!));
      else if (kind === "part")
        bundle.messages[0]!.parts.push(structuredClone(bundle.messages[0]!.parts[0]!));
      else {
        const entry = {
          id:
            kind === "entry"
              ? "duplicate-entry"
              : `v4_command_fact:child:${PARENT_ID}:${bundle.commandFact.sourceCommandId}`,
          sessionID: CHILD_ID,
          type: "entry",
          time: { created: 1, updated: 1 },
          data: {},
        };
        bundle.entries.push(entry);
        if (kind === "entry") bundle.entries.push(structuredClone(entry));
      }
      await expect(store.commitForkBundle(bundle)).rejects.toThrow(/duplicate|conflict/i);
      expect(await store.getSession(CHILD_ID)).toBeNull();
    },
  );

  it("已提交命令重放优先返回原child，不被已存在的正文主键阻断", async () => {
    const { store, bundle } = await fixture();
    await store.commitForkBundle(bundle);
    const original = await store.messages({ sessionID: CHILD_ID });
    const replay: ForkCommitBundle = structuredClone(bundle);
    replay.messages[0]!.parts.push(structuredClone(replay.messages[0]!.parts[0]!));
    expect((await store.commitForkBundle(replay)).id).toBe(CHILD_ID);
    expect(await store.messages({ sessionID: CHILD_ID })).toEqual(original);
  });
});
