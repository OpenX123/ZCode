import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

export interface EnsureDesktopDeviceMidSyncOptions {
  /** state 文件所在目录，默认 getAppConfigDir()（即 ~/.zcode/v2）。仅测试注入 */
  configDir?: string;
  /** UUID 生成器，默认 createUuid。仅测试注入 */
  createId?: () => string;
}

/**
 * 本地 stream client 的稳定身份，在窗口创建前经 preload 注入。
 * 沿用旧文件名和已有值，避免升级时改变会话客户端身份；不参与网络上报。
 * 原子写入只补缺失的 ID，保留同文件的历史字段。
 */
export function ensureDesktopDeviceMidSync(options?: EnsureDesktopDeviceMidSyncOptions): string {
  const createId = options?.createId ?? createUuid;
  try {
    const configDir = options?.configDir ?? getAppConfigDir();
    const stateFile = join(configDir, "telemetry-state.json");

    const state = readTelemetryStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeTelemetryStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // fs / JSON 异常兜底：保证一定有返回值，窗口创建不阻塞
    return createId();
  }
}

function readTelemetryStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeTelemetryStateSync(stateFile: string, state: Record<string, unknown>): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}
