import { execFile } from "node:child_process";
import type { WindowsTaskkillRunner } from "#src/process/processTreeTypes.js";
import { isWindowsPid } from "#src/process/processTreeSnapshot.js";

export const defaultWindowsTaskkillRunner: WindowsTaskkillRunner = ({ force, pid, timeoutMs }) =>
  new Promise((resolve) => {
    if (!isWindowsPid(pid) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      resolve({ error: new Error("Invalid Windows exact PID taskkill request") });
      return;
    }
    // 多个 workspace 退出时，同步 taskkill 会按 Agent 数量串行阻塞 Host。
    // 异步 runner 让进程树并发收口，并把命令完成结果交给等待式状态机观察。
    execFile(
      "taskkill",
      ["/PID", String(pid), ...(force ? ["/F"] : [])],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ ...(error ? { error } : {}), ...(stderr ? { stderr } : {}) });
      },
    );
  });
