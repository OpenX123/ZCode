import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { terminateGenericPosixProcessGroup } from "./process-tree.js";
/** ACP 需要可双向写入的 stdio；统一留在 exec 基础设施，不经 shell。 */
export function spawnAcpProcess(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(file, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}
export async function closeAcpProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  if (!child.pid) return;
  if (process.platform !== "win32") {
    terminateGenericPosixProcessGroup(child);
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      child.kill();
      resolve();
    });
    killer.once("exit", () => resolve());
  });
}
