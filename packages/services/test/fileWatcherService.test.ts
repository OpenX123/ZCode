import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileWatchEvent } from "@zcode/shared";
import {
  collapseRecursiveWatchChangedPaths,
  createFileWatcherService,
  resolveFileWatchChangedPath,
} from "../src/fileWatcher/fileWatcherService.js";
import { collectServiceMemoryDiagnostics } from "../src/memoryDiagnostics.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-file-watcher-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fileWatcherService", () => {
  it("resolves a changed child path and keeps unknown watcher paths conservative", () => {
    const watchedPath = resolve("workspace", "slides");
    // 修复原因：旧断言写死 POSIX 路径；产品使用宿主 path.resolve，Windows 会返回盘符与反斜杠。
    expect(resolveFileWatchChangedPath(watchedPath, "deck.pptx")).toBe(
      resolve(watchedPath, "deck.pptx"),
    );
    expect(resolveFileWatchChangedPath(watchedPath, null)).toBeUndefined();
  });

  it("treats a stale watcher subscription as a no-op event", async () => {
    const service = createFileWatcherService();
    const dir = makeTempDir();
    const { id } = await service.watch({ path: dir });

    await service.unwatch({ id });

    let fired = false;
    const subscription = service.onDynamicChange(id)(() => {
      fired = true;
    });
    subscription.dispose();

    expect(fired).toBe(false);
  });

  it("disposes all active watchers and keeps stale ids no-op", async () => {
    const service = createFileWatcherService();
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const first = await service.watch({ path: firstDir });
    const second = await service.watch({ path: secondDir });

    service.disposeAll();
    await service.unwatch(first);
    await service.unwatch(second);

    let fired = false;
    const firstSubscription = service.onDynamicChange(first.id)(() => {
      fired = true;
    });
    const secondSubscription = service.onDynamicChange(second.id)(() => {
      fired = true;
    });
    firstSubscription.dispose();
    secondSubscription.dispose();

    expect(fired).toBe(false);
  });

  it("递归 watcher 的批次超过上限时逐级折叠为祖先目录", () => {
    const root = resolve("workspace");
    const paths = [
      ...Array.from({ length: 40 }, (_, index) =>
        resolve(root, "node_modules", `pkg-${index}`, "index.js"),
      ),
      resolve(root, "src", "a.ts"),
    ];
    expect(collapseRecursiveWatchChangedPaths(root, paths.slice(0, 3), 32)).toEqual(
      paths.slice(0, 3),
    );
    expect(collapseRecursiveWatchChangedPaths(root, paths, 32)).toEqual([
      resolve(root, "node_modules"),
      resolve(root, "src"),
    ]);
    expect(
      collapseRecursiveWatchChangedPaths(
        root,
        Array.from({ length: 40 }, (_, index) => resolve(root, `file-${index}.ts`)),
        32,
      ),
    ).toEqual([root]);
  });

  it("递归 watcher 按路径逐个上报 changedPath，供 Git 自动刷新过滤 ignored 与 gitdir 噪声", async () => {
    // P8：旧实现一个批次只要含多个路径就省略 changedPath，UI 无法区分 node_modules 与源码改动。
    const service = createFileWatcherService();
    const dir = makeTempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    const { id } = await service.watch({ path: dir, recursive: true });
    const events: FileWatchEvent[] = [];
    const subscription = service.onDynamicChange(id)((event) => events.push(event));
    try {
      writeFileSync(join(dir, "src", "a.ts"), "a");
      writeFileSync(join(dir, "node_modules", "b.js"), "b");
      await vi.waitFor(
        () => {
          const changed = new Set(events.map((event) => event.changedPath));
          expect(changed.has(join(dir, "src", "a.ts"))).toBe(true);
          expect(changed.has(join(dir, "node_modules", "b.js"))).toBe(true);
        },
        { timeout: 3_000, interval: 50 },
      );
      expect(events.every((event) => event.dirPath === dir)).toBe(true);
    } finally {
      subscription.dispose();
      service.disposeAll();
    }
  });
});

describe("fileWatcher memory diagnostics", () => {
  it("注册 open watcher 计数，disposeAll 后注销", async () => {
    const service = createFileWatcherService();
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBe(0);
    await service.watch({ path: makeTempDir() });
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBe(1);
    service.disposeAll();
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBeUndefined();
  });
});
