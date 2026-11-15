import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent, type MessageWithParts } from "@zcode/contracts";
import {
  conversationSnapshotSchema,
  applyConversationDeltas,
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

const media = {
  id: "file1",
  mediaType: "audio" as const,
  mimeType: "audio/mpeg",
  source: { kind: "artifact" as const, uri: "zcode-artifact://s1/audio1" },
};
const event = (type: string, payload: unknown, n: number): SessionEvent =>
  ({
    id: `e${n}`,
    sessionId: "s1",
    turnId: "t1",
    traceId: "trace",
    timestamp: new Date(n),
    sequenceNumber: n,
    type,
    payload,
  }) as SessionEvent;
const streams = [
  event(SessionEventType.TurnStarted, { turnNumber: 1, input: "展示媒体" }, 1),
  event(
    SessionEventType.ModelStreaming,
    { kind: "text_start", delta: "", done: false, assistantMessageId: "a1", partId: "file1" },
    2,
  ),
  event(
    SessionEventType.ModelStreaming,
    {
      kind: "text_delta",
      delta: "",
      done: false,
      assistantMessageId: "a1",
      partId: "file1",
      media: [media],
    },
    3,
  ),
  event(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false, assistantMessageId: "a1", partId: "file1" },
    4,
  ),
  event(
    SessionEventType.TurnComplete,
    { resultType: "success", durationMs: 4, toolCallCount: 0 },
    5,
  ),
];
describe("原生媒体同源投影", () => {
  it.each(["continuous", "replayable"] as const)(
    "%s 的 upsert/snapshot 接纳媒体；重放不依赖文本",
    (profile) => {
      const projection = new ProductProjection("s1", "epoch");
      let view = projection.getSnapshot();
      for (const input of streams) {
        const deltas = projection.applyEvent(input);
        view = applyConversationDeltas(
          view,
          filterConversationDeltasForProfile(deltas, DELIVERY_PROFILES[profile]),
        );
      }
      const snapshot = conversationSnapshotSchema.parse(projection.getSnapshot());
      expect(snapshot.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: "",
          media: [media],
          state: "complete",
        }),
      );
      expect(view.rows.window).toEqual(snapshot.rows.window);
      expect(projection.applyEvent(streams[2]!)).toEqual([]);
    },
  );
  it("FilePart 冷恢复保留媒体和读取引用；旧 text 行继续兼容", () => {
    const messages = [
      {
        info: {
          id: "u1",
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "default",
          modelSelection: { providerId: "p", modelId: "m" },
        },
        parts: [{ id: "u1-t", sessionID: "s1", messageID: "u1", type: "text", text: "展示媒体" }],
      },
      {
        info: {
          id: "a1",
          sessionID: "s1",
          role: "assistant",
          time: { created: 2, completed: 5 },
          parentID: "u1",
          providerId: "p",
          modelId: "m",
          mode: "default",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "file1",
            sessionID: "s1",
            messageID: "a1",
            type: "file",
            mime: "audio/mpeg",
            url: media.source.uri,
            metadata: {
              storageKind: "artifact",
              artifactUri: media.source.uri,
              assistantMedia: media,
            },
          },
        ],
      },
    ] as MessageWithParts[];
    const projection = new ProductProjection("s1", "cold");
    for (const input of synthesizeEventsFromMessages(messages, { sessionId: "s1" }))
      projection.applyEvent(input);
    expect(projection.getSnapshot().rows.window).toContainEqual(
      expect.objectContaining({ kind: "assistantText", text: "", media: [media] }),
    );
  });
});
