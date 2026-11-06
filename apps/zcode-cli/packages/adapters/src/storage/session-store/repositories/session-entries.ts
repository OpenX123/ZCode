import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionEntryInfo,
  type SessionEntryType,
  type SessionId,
} from "@zcode/contracts";
import { decodeSessionEntryRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionEntryRow } from "../rows.js";
import { touchSession } from "./sessions.js";

function encodeSessionEntryData(input: SessionEntryInfo): string {
  // 旧版读取 data 的平铺身份；新版 port 仍传逻辑 Selection，包装只属于存储 adapter。
  // undefined 与既有 fork 的 null 都写成明确空值，防止重启重新导入旧字段。
  const encoded = encodeJson(
    input.type === SESSION_ENTRY_MODEL_SELECTION
      ? { modelSelection: input.data ?? null }
      : input.data,
  );
  if (!encoded) {
    throw new Error("Session entry data must be JSON-serializable");
  }
  return encoded;
}

export function saveSessionEntry(db: DatabaseSync, input: SessionEntryInfo): void {
  const isModelSelection = input.type === SESSION_ENTRY_MODEL_SELECTION;
  const encoded = encodeSessionEntryData(input);

  db.prepare(
    `
      insert into session_entry (id, session_id, type, time_created, time_updated, data)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        session_id = excluded.session_id,
        type = excluded.type,
        time_updated = excluded.time_updated,
        data = case
          when ? and session_entry.type = excluded.type
            and session_entry.session_id = excluded.session_id
            and json_type(session_entry.data) = 'object'
          then json_set(session_entry.data, '$.modelSelection', json_extract(excluded.data, '$.modelSelection'))
          else excluded.data
        end
      `,
  ).run(
    input.id,
    input.sessionID,
    input.type,
    input.time.created,
    input.time.updated,
    encoded,
    Number(isModelSelection),
  );
  if (input.touchSession !== false) {
    touchSession(db, input.sessionID, input.time.updated);
  }
}

export function saveSessionEntryIfAbsent(db: DatabaseSync, input: SessionEntryInfo): boolean {
  // Bug 根因：先读后 upsert 无法阻止多个 CLI 同时导出，必须由全库主键原子决定唯一 writer。
  const result = db
    .prepare(
      `
      insert into session_entry (id, session_id, type, time_created, time_updated, data)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do nothing
      `,
    )
    .run(
      input.id,
      input.sessionID,
      input.type,
      input.time.created,
      input.time.updated,
      encodeSessionEntryData(input),
    );
  const inserted = Number(result.changes) === 1;
  if (inserted && input.touchSession !== false) {
    touchSession(db, input.sessionID, input.time.updated);
  }
  return inserted;
}

export function sessionEntries(
  db: DatabaseSync,
  input: { sessionID: SessionId; type?: SessionEntryType | string },
): SessionEntryInfo[] {
  const rows = input.type
    ? db
        .prepare(
          `
          select * from session_entry
          where session_id = ? and type = ?
          order by time_created, rowid
          `,
        )
        .all(input.sessionID, input.type)
    : db
        .prepare(
          `
          select * from session_entry
          where session_id = ?
          order by time_created, rowid
          `,
        )
        .all(input.sessionID);

  return (rows as unknown as SessionEntryRow[]).map(decodeSessionEntryRow);
}
