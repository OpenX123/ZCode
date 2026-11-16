import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPosixReleaseArchive } from "../src/packaging/posixArchive/index.js";

const { createWriteStream } = vi.hoisted(() => ({ createWriteStream: vi.fn() }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  createWriteStream,
}));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

describe("POSIX archive cancellation completion", () => {
  it("在实际输出进度后abort，等待输出流destroy完成才拒绝且不再写", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-posix-archive-cancel-"));
    roots.push(root);
    const input = join(root, "input");
    await mkdir(input);
    await writeFile(join(input, "payload"), Buffer.alloc(1024 * 1024, 7));
    const firstWrite = barrier();
    const destroying = barrier();
    const finishDestroy = barrier();
    let writes = 0;
    let destroyCompleted = false;
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1;
        firstWrite.release();
        callback();
      },
      destroy(error, callback) {
        destroying.release();
        void finishDestroy.reached.then(() => {
          destroyCompleted = true;
          callback(error);
        });
      },
    });
    createWriteStream.mockReturnValue(sink);
    const controller = new AbortController();
    let settled = false;
    const pending = createPosixReleaseArchive({
      releaseDir: input,
      archivePath: join(root, "out.tar.gz"),
      layout: "component",
      signal: controller.signal,
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await firstWrite.reached;
    expect(writes).toBeGreaterThan(0);
    controller.abort();
    await destroying.reached;
    // 用销毁屏障证明完成语义，不能只证明signal被传给pipeline或延时等待5min。
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(destroyCompleted).toBe(false);
    finishDestroy.release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(destroyCompleted).toBe(true);
    expect(sink.destroyed).toBe(true);
    const completedWrites = writes;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toBe(completedWrites);
  });
});
