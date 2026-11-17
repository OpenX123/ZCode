import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./e2e/helpers/upstream-replay-server.js";

const servers: UpstreamReplayServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sseEvent(type: string, data: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function controlledFixture(id: string, prompt: string, running: string, done: string) {
  const usage = {
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    service_tier: "standard",
  };
  return {
    id,
    metadata: { timingPolicy: "controlled-stream" },
    match: { method: "POST", pathIncludes: "/messages", lastUserMessageIncludes: [prompt] },
    response: {
      statusCode: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      releaseAfterChunks: 1,
      chunks: [
        {
          offsetMs: 0,
          text: [
            sseEvent("message_start", {
              message: {
                id,
                type: "message",
                role: "assistant",
                model: "fixture-model",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage,
              },
            }),
            sseEvent("content_block_start", {
              index: 0,
              content_block: { type: "text", text: "" },
            }),
            sseEvent("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: running },
            }),
          ].join(""),
        },
        {
          offsetMs: 0,
          text: [
            sseEvent("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: done },
            }),
            sseEvent("content_block_stop", { index: 0 }),
            sseEvent("message_delta", {
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { ...usage, output_tokens: 2 },
            }),
            sseEvent("message_stop"),
          ].join(""),
        },
      ],
    },
  };
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-mobile-fixture-"));
  directories.push(directory);
  // 旧手机 E2E fixture 已退役；通用 gate/matcher 回归由本测试在临时目录自持。
  const fixturePath = join(directory, "fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify({
      version: 1,
      fixtures: [
        controlledFixture(
          "r3-mob-slow",
          "E2E_R3_MOBILE_SLOW",
          "R3_MOBILE_STREAMING",
          "R3_MOBILE_STREAM_DONE",
        ),
        controlledFixture(
          "r3-mob-from-mobile",
          "E2E_R3_MOBILE_FROM_MOBILE",
          "R3_MOBILE_FROM_MOBILE_RUNNING",
          "R3_MOBILE_FROM_MOBILE_REPLY",
        ),
        {
          id: "r3-mob-from-desktop",
          match: {
            method: "POST",
            pathIncludes: "/messages",
            lastUserMessageIncludes: ["E2E_R3_MOBILE_FROM_DESKTOP"],
          },
          response: { statusCode: 200, text: "R3_MOBILE_FROM_DESKTOP_REPLY" },
        },
      ],
    }),
    "utf-8",
  );
  const server = await startUpstreamReplayServer({
    artifactPath: join(directory, "requests.json"),
    fixturePaths: [fixturePath],
  });
  servers.push(server);
  return server;
}

describe("自含 upstream replay fixture 的 gate 与最新 user 匹配", () => {
  it.each([
    {
      fixtureId: "r3-mob-slow",
      prompt: "E2E_R3_MOBILE_SLOW",
      running: "R3_MOBILE_STREAMING",
      done: "R3_MOBILE_STREAM_DONE",
    },
    {
      fixtureId: "r3-mob-from-mobile",
      prompt: "E2E_R3_MOBILE_FROM_MOBILE",
      running: "R3_MOBILE_FROM_MOBILE_RUNNING",
      done: "R3_MOBILE_FROM_MOBILE_REPLY",
    },
  ])(
    "$fixtureId 在显式释放前不结束，完成标记只在释放后出现",
    async ({ fixtureId, prompt, running, done }) => {
      const server = await start();
      const response = await fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes(running)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).not.toContain(done);
      expect(text).not.toContain("event: message_stop");
      expect(await fetch(`${server.baseUrl}/__e2e__/gates`).then((value) => value.json())).toEqual([
        fixtureId,
      ]);
      expect(
        (await fetch(`${server.baseUrl}/__e2e__/release/${fixtureId}`, { method: "POST" })).status,
      ).toBe(204);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text.match(new RegExp(done, "gu"))).toHaveLength(1);
      expect(text).toContain("event: message_stop");
    },
  );

  it("桌面输入携带手机历史时仍命中桌面回复，不误命中旧手机回合", async () => {
    const server = await start();
    const response = await fetch(`${server.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "E2E_R3_MOBILE_FROM_MOBILE" },
          { role: "assistant", content: "R3_MOBILE_FROM_MOBILE_REPLY" },
          { role: "user", content: "E2E_R3_MOBILE_FROM_DESKTOP" },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("R3_MOBILE_FROM_DESKTOP_REPLY");
    expect(text).not.toContain("R3_MOBILE_FROM_MOBILE_REPLY");
  });
});
