import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { terminateGenericPosixProcessGroup } from "./process-tree.js";
/** ACP 需要可双向写入的 stdio；统一留在 exec 基础设施，不经 shell。 */
export function spawnAcpProcess(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const startedAt = Date.now();
  const child = spawn(file, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const lifetime = { startedAt, exitedAt: undefined as number | undefined };
  processLifetimes.set(child, lifetime);
  child.once("exit", () => {
    lifetime.exitedAt = Date.now();
  });
  return child;
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

interface AcpProcessFact {
  pid: number;
  parent: number;
  group?: number;
  identity: string;
  born: number;
  zombie?: boolean;
}
const processLifetimes = new WeakMap<
  ChildProcessWithoutNullStreams,
  { startedAt: number; exitedAt?: number }
>();
const strictClosures = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
const strictSnapshots = new WeakMap<ChildProcessWithoutNullStreams, Map<number, AcpProcessFact>>();

/** 专用于未绑定 ACP 资源：只有 OS 已确认同身份进程树退出才 resolve，失败保留快照供重试。 */
export function closeAcpProcessAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  const existing = strictClosures.get(child);
  if (existing) return existing;
  const closing = closeAcpProcessTree(child);
  // 成功是永久退出事实；只在失败时开放重试，避免重复关闭重新观察已复用的旧 PID。
  void closing.catch(() => {
    if (strictClosures.get(child) === closing) strictClosures.delete(child);
  });
  strictClosures.set(child, closing);
  return closing;
}

async function closeAcpProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) {
    child.stdin.end();
    return;
  }
  const rootPid = child.pid;
  const lifetime = processLifetimes.get(child);
  const owned = strictSnapshots.get(child) ?? new Map<number, AcpProcessFact>();
  strictSnapshots.set(child, owned);
  const deadline = Date.now() + 10_000;
  const observe = async () => {
    const facts = await readAcpProcessTable(deadline);
    const byPid = new Map(facts.map((fact) => [fact.pid, fact]));
    const root = byPid.get(rootPid);
    const rootMatches =
      root &&
      (!owned.has(rootPid) || owned.get(rootPid)!.identity === root.identity) &&
      (!lifetime || Math.abs(root.born - lifetime.startedAt) < 2_000) &&
      ((child.exitCode === null && child.signalCode === null) ||
        owned.get(rootPid)?.identity === root.identity ||
        (lifetime?.exitedAt !== undefined && root.born <= lifetime.exitedAt));
    if (root && !rootMatches && child.exitCode === null && child.signalCode === null)
      throw new Error("ACP process root identity could not be confirmed");
    if (rootMatches) owned.set(rootPid, root);
    // 身份一旦归属便固定；PID 被复用不能覆写旧快照、更不能把新进程当成旧树终止。
    const remember = (fact: AcpProcessFact) => {
      const previous = owned.get(fact.pid);
      if (previous && previous.identity !== fact.identity) return false;
      owned.set(fact.pid, fact);
      return true;
    };
    // 组长退出后 POSIX PGID 仍归旧组；若 PID 已被新组长复用，绝不对新组发信号。
    const groupReused = Boolean(
      root && !rootMatches && owned.get(rootPid)?.identity !== root.identity,
    );
    if (process.platform !== "win32" && !groupReused)
      for (const fact of facts) if (fact.group === rootPid) remember(fact);
    // Windows 保留 ParentProcessId，根已退出也可找回其后代；时间窗排除复用 PID 的新树。
    const parents = new Set(
      [...owned.values()]
        .filter((fact) => byPid.get(fact.pid)?.identity === fact.identity)
        .map((fact) => fact.pid),
    );
    if (!groupReused) parents.add(rootPid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const fact of facts) {
        if (!parents.has(fact.parent) || parents.has(fact.pid)) continue;
        if (
          fact.parent === rootPid &&
          lifetime &&
          (fact.born < lifetime.startedAt - 2_000 || fact.born > (lifetime.exitedAt ?? Infinity))
        )
          continue;
        if (!remember(fact)) continue;
        parents.add(fact.pid);
        changed = true;
      }
    }
    return {
      groupReused,
      live: [...owned.values()].filter((fact) => {
        const current = byPid.get(fact.pid);
        return current?.identity === fact.identity && !current.zombie;
      }),
    };
  };
  let observed = await observe();
  // 必须先快照再 EOF，不能让组长先退出而丢失后代事实。
  child.stdin.end();
  const signal = (kind: NodeJS.Signals) => {
    const kill = (pid: number) => {
      try {
        process.kill(pid, kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    if (!observed.groupReused) kill(-rootPid);
    for (const fact of observed.live) kill(fact.pid);
  };
  let forced = false;
  const forceAt = Date.now() + 750;
  if (process.platform !== "win32" && observed.live.length > 0) signal("SIGTERM");
  while (observed.live.length > 0) {
    if (Date.now() >= deadline) throw new Error("ACP process tree exit could not be confirmed");
    if (process.platform === "win32") {
      // taskkill 的返回只是操作结果，随后必须重新观测；失败不能退化成只杀根并宣告成功。
      const livePids = new Set(observed.live.map((fact) => fact.pid));
      for (const fact of observed.live.filter((item) => !livePids.has(item.parent))) {
        try {
          await readProcessCommand("taskkill", ["/PID", String(fact.pid), "/T", "/F"], deadline);
        } catch {
          observed = await observe();
          if (observed.live.length > 0) throw new Error("ACP process tree termination failed");
        }
      }
    } else if (!forced && Date.now() >= forceAt) {
      signal("SIGKILL");
      forced = true;
    }
    observed = await observe();
    if (observed.live.length > 0) await delay(25);
  }
  strictSnapshots.delete(child);
}

async function readAcpProcessTable(deadline: number): Promise<AcpProcessFact[]> {
  if (process.platform === "win32") {
    const output = await readProcessCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;identity=$_.CreationDate.ToString('o')} }) | ConvertTo-Json -Compress",
      ],
      deadline,
    );
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error("ACP process observation unavailable");
    return value.map((row: Record<string, unknown>) => {
      if (
        typeof row.pid !== "number" ||
        typeof row.parent !== "number" ||
        typeof row.identity !== "string"
      )
        throw new Error("ACP process observation unavailable");
      const born = Date.parse(row.identity);
      if (!Number.isFinite(born)) throw new Error("ACP process identity unavailable");
      return { pid: row.pid, parent: row.parent, identity: row.identity, born };
    });
  }
  const output = await readProcessCommand(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart="],
    deadline,
  );
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
      if (!match) throw new Error("ACP process observation unavailable");
      const born = Date.parse(match[5]!);
      if (!Number.isFinite(born)) throw new Error("ACP process identity unavailable");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        identity: match[5]!,
        born,
        zombie: match[4]!.startsWith("Z"),
      };
    });
}

function readProcessCommand(file: string, args: string[], deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let output = "";
    const timeout = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new Error("ACP process observation timed out"));
      },
      Math.max(1, Math.min(5_000, deadline - Date.now())),
    );
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error("ACP process operation failed"));
    });
  });
}
