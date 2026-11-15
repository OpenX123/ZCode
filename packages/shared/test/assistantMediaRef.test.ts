import { describe, expect, it } from "vitest";
import * as protocol from "../src/zcode-protocol-v4/index.js";
import { zcodeModelStreamingEventPayloadSchema } from "../src/zcode-protocol/index.js";

const media = {
  id: "part-1",
  mediaType: "audio",
  mimeType: "audio/mpeg",
  source: { kind: "artifact", uri: "zcode-artifact://session-1/media-1" },
};
const row = {
  rowId: 1,
  turnId: "turn-1",
  entityId: "assistant-1",
  createdAt: 1000,
  createdAtSeq: 1,
  kind: "assistantText",
  text: "",
  state: "complete",
};
describe("AssistantMediaRef 同源 wire 合同", () => {
  it("音频字节响应通过跨进程读取schema，保持20 MiB总量边界", () => {
    const response = {
      dataBase64: "YWJj",
      mediaType: "audio/wav",
      totalBytes: 3,
      nextOffset: null,
    };
    expect(protocol.v4AttachmentReadResultSchema.safeParse(response).success).toBe(true);
    expect(
      protocol.v4AttachmentReadResultSchema.safeParse({
        ...response,
        totalBytes: 20 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });
  it("旧行缺省兼容；空正文媒体经过行与 strict ModelStreaming 不丢失", () => {
    expect(protocol.assistantTextRowSchema.parse(row)).toEqual(row);
    expect(protocol.assistantTextRowSchema.parse({ ...row, media: [media] })).toMatchObject({
      media: [media],
    });
    expect(
      zcodeModelStreamingEventPayloadSchema.parse({
        kind: "text_delta",
        delta: "",
        media: [media],
      }),
    ).toMatchObject({ media: [media] });
  });
  it.each([
    { ...media, mimeType: "video/mp4" },
    { ...media, id: "" },
    { ...media, name: "x".repeat(513) },
    { ...media, source: { kind: "artifact", uri: "file:///private" } },
    { ...media, source: { kind: "artifact", uri: "zcode-artifact://s/../private" } },
    { ...media, source: { kind: "url", url: "data:audio/mpeg;base64,YQ==" } },
    { ...media, source: { kind: "url", url: "not-a-url" } },
    { ...media, source: { kind: "url", url: "https://user:secret@example.com/a" } },
    { ...media, source: { kind: "url", url: `https://example.com/${"x".repeat(4096)}` } },
    { ...media, data: "YQ==" },
  ])("拒绝无效 MIME、来源、边界和内联本体 %j", (invalid) => {
    expect(protocol.assistantTextRowSchema.safeParse({ ...row, media: [invalid] }).success).toBe(
      false,
    );
  });
  it("每行条目有界", () =>
    expect(
      protocol.assistantTextRowSchema.safeParse({ ...row, media: Array(33).fill(media) }).success,
    ).toBe(false));
});
