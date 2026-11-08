import { watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import {
  createServiceLogger,
  type ServiceLogger,
} from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** 防抖时间（ms）——批量文件变更（如 git checkout）时避免频繁刷新 */
const DEBOUNCE_MS = 150;
/** 递归 watcher 单个批次逐路径上报的上限；超出后折叠为祖先目录。 */
const RECURSIVE_WATCH_MAX_CHANGED_PATHS = 32;

interface WatcherInstance {
  path: string;
  recursive: boolean;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** 防抖定时器 */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 非递归：同一防抖窗口只含一个明确路径时才透传，避免过滤掉同批次里的目标文件事件；
   * 递归：逐路径上报（见 collapseRecursiveWatchChangedPaths）。
   */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

export function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

function isInsideWatchRoot(rootPath: string, path: string): boolean {
  const relativePath = relative(rootPath, path);
  // Windows 跨盘符时 relative 返回绝对路径，同样视为在监听根之外。
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function watchDepth(rootPath: string, path: string): number {
  if (!isInsideWatchRoot(rootPath, path)) return 0;
  return relative(rootPath, path).split(/[\\/]+/).length;
}

/**
 * 递归 watcher 一个批次的变化路径：不超过上限时原样返回；超出时每轮只把最深的一层路径上提到
 * 父目录，直到不超过上限（最终可能只剩监听根目录）。折叠后的路径表示“该目录下有变化”。
 */
export function collapseRecursiveWatchChangedPaths(
  rootPath: string,
  changedPaths: readonly string[],
  limit = RECURSIVE_WATCH_MAX_CHANGED_PATHS,
): string[] {
  let current = [...new Set(changedPaths)];
  while (current.length > limit) {
    const deepest = Math.max(...current.map((path) => watchDepth(rootPath, path)));
    if (deepest === 0) return [rootPath];
    current = [
      ...new Set(
        current.map((path) => {
          if (watchDepth(rootPath, path) !== deepest) return path;
          const parent = dirname(path);
          return isInsideWatchRoot(rootPath, parent) ? parent : rootPath;
        }),
      ),
    ];
  }
  return current;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 watcher 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // 默认非递归监视单个目录；Git 状态这类工作区级信号会显式打开 recursive。
        fsWatcher = watch(params.path, { recursive }, (_eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          // 防抖：连续变更只触发一次刷新
          if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
          instance.debounceTimer = setTimeout(() => {
            instance.debounceTimer = null;
            const changedPaths = [...instance.pendingChangedPaths];
            const hasUnknownChangedPath = instance.hasUnknownChangedPath;
            instance.pendingChangedPaths.clear();
            instance.hasUnknownChangedPath = false;
            if (instance.recursive && !hasUnknownChangedPath && changedPaths.length > 1) {
              // 递归 watcher 只服务 Git 自动刷新这类工作区级信号。P8：旧实现批次含多个路径就省略
              // changedPath，UI 无法区分 node_modules / 构建产物 / .git 噪声与源码改动，只能保守刷新。
              // 这里逐路径上报（超上限折叠为祖先目录），由 UI 按 gitdir 与 .gitignore 过滤。
              for (const changedPath of collapseRecursiveWatchChangedPaths(
                instance.path,
                changedPaths,
              ))
                instance.changeEmitter.fire({ dirPath: instance.path, changedPath });
              return;
            }
            const onlyChangedPath =
              !hasUnknownChangedPath && changedPaths.length === 1 ? changedPaths[0] : undefined;
            instance.changeEmitter.fire({
              dirPath: instance.path,
              ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
            });
          }, DEBOUNCE_MS);
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法监视目录 '${params.path}': ${message}`);
      }

      // 监视目录被删除/重命名时，发送最终事件并清理
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "文件监听器异常，清理 watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      watchers.set(id, {
        path: params.path,
        recursive,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // watch() 成功返回后，renderer 订阅 onDynamicChange 前，底层 fs.watch
        // 仍可能因目录删除/重命名/平台 watcher 错误触发 cleanup。stale watcher id
        // 是可恢复状态，不能 throw 到 RPC 事件订阅链路导致 host 进程退出。
        log.warn(undefined, "忽略已失效的文件监听订阅", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
