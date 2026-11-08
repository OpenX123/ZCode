import { dirname, join } from "node:path";
import {
  getTasksIndexDatabasePath,
  markTasksStoragePrepared,
  resolveZCodeAgentSpawnCwd,
} from "@zcode/services/storage-startup";
import type { DatabaseStartupState } from "@zcode/shared";
import { DatabaseStartupCoordinator } from "../databaseStartupCoordinator.js";
import { StartupDiskSampler } from "../startupDiskSampler.js";
import { prepareHostStorage, prepareSessionStorage } from "./storagePreparationProcesses.js";

const BASELINE_BUDGET_MS = 250;

/** 启动阶段日志字段：只允许数字、布尔与短枚举，不含路径或正文。 */
export type HostDatabaseStartupStageFields = Record<string, number | boolean | string>;

export function createHostDatabaseStartup(options: {
  startupId?: string;
  cwd: string;
  workingDirectories?: string[];
  env?: Record<string, string>;
  publish: (state: DatabaseStartupState) => void;
  initializeServices: () => Promise<void>;
  onFailure: (error: unknown) => void;
  /**
   * 每个阶段完成时调用一次（info 打点）。修复原因（2026-11-08 本机扫描）：Host fork 到
   * `initializing local services` 有 2.3–4.3s，期间没有任何分阶段日志，无法定位关键路径。
   */
  logStage?: (stage: string, fields: HostDatabaseStartupStageFields) => void;
}) {
  const abort = new AbortController();
  let sampler: StartupDiskSampler | undefined;
  const logStage = (stage: string, fields: HostDatabaseStartupStageFields) => {
    try {
      options.logStage?.(stage, fields);
    } catch {
      /* 打点失败不能改变启动结果。 */
    }
  };
  const coordinator = new DatabaseStartupCoordinator({
    startupId: options.startupId,
    publish: options.publish,
    prepare: async (report) => {
      const preparedPaths = new Set<string>();
      sampler = new StartupDiskSampler({ onSample: (disk) => coordinator.updateDisk(disk) });
      const currentSampler = sampler;
      const startedAt = performance.now();
      let stage = "tasks_baseline";
      let stageStartedAt = startedAt;
      const finishStage = (fields: HostDatabaseStartupStageFields = {}) => {
        const now = performance.now();
        logStage(stage, { durationMs: Math.round(now - stageStartedAt), ...fields });
        stageStartedAt = now;
      };
      const observePath = async (path: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            currentSampler.addPath(path),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, BASELINE_BUDGET_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        currentSampler.sealBaseline(path);
        coordinator.updateDisk(currentSampler.snapshot());
      };
      try {
        report("preparing_host_storage", "checking");
        const tasksPath = getTasksIndexDatabasePath();
        await observePath(tasksPath);
        finishStage();
        currentSampler.start();
        stage = "tasks_index";
        await prepareHostStorage(
          tasksPath,
          (phase, migration) =>
            report("preparing_host_storage", phase, { databaseId: "tasks-index", migration }),
          abort.signal,
        );
        markTasksStoragePrepared(tasksPath);
        finishStage();
        report("preparing_session_storage", "checking");
        stage = "session_cwd";
        const candidates = options.workingDirectories?.length
          ? options.workingDirectories
          : [options.cwd];
        const directories = new Set<string>();
        for (const candidate of candidates) {
          // 历史项目 ENOTDIR/无权限不是数据库失败；与普通 Agent 使用同一 cwd 选择规则。
          const { cwd } = await resolveZCodeAgentSpawnCwd({
            requestedCwd: candidate,
            workspacePath: candidate,
            spawnFallbackCwd: options.cwd,
          });
          directories.add(cwd);
        }
        finishStage({ directoryCount: directories.size });
        // 存储准备 Worker 的 Node 编译缓存放在应用数据目录（与 tasks-index 同级），随数据目录隔离。
        const compileCacheDir = join(dirname(tasksPath), "cache", "node-compile-cache");
        // 相对 sessionDbPath 按实际进程 cwd 解析；不能先准备 fallback 下的另一个空库。
        const pendingDirectories = [...directories];
        for (const [index, cwd] of pendingDirectories.entries()) {
          stage = "session_storage";
          const timing = await prepareSessionStorage({
            cwd,
            env: options.env,
            signal: abort.signal,
            preparedPaths,
            compileCacheDir,
            report: (phase, details) =>
              report("preparing_session_storage", phase, {
                databaseId: details?.databaseId ?? "session",
                migration: details?.migration,
                finalDatabase: index === pendingDirectories.length - 1,
              }),
            observePath,
          });
          finishStage({ index, ...timing });
        }
        report("starting_services");
        stage = "services_init";
        await options.initializeServices();
        finishStage();
        logStage("completed", { totalMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        logStage("failed", {
          failedStage: stage,
          totalMs: Math.round(performance.now() - startedAt),
        });
        try {
          options.onFailure(error);
        } catch {
          /* 诊断失败不覆盖原始错误。 */
        }
        throw error;
      } finally {
        currentSampler.stop();
        coordinator.updateDisk(currentSampler.snapshot());
      }
    },
  });
  return {
    coordinator,
    dispose: () => {
      abort.abort();
      sampler?.stop();
    },
  };
}
