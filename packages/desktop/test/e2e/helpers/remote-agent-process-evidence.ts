import { posix } from "node:path";
import { ZCODE_AGENT_RUNTIME } from "@zcode/shared";

const nativeSegments = [
  "agents",
  ZCODE_AGENT_RUNTIME.bundledResourceDir,
  ...ZCODE_AGENT_RUNTIME.resolveEntrySegments("linux"),
];
if (nativeSegments.some((segment) => !/^[a-zA-Z0-9._-]+$/u.test(segment)))
  throw new Error("Remote Agent evidence: descriptor-invalid");

// process.title 会覆盖 Linux 可见 cmdline。只输出分类与身份，不回传完整 argv；一次命令共用既有控制截止。
export const REMOTE_AGENT_PROCESS_SCAN = String.raw`set -eu
export LC_ALL=C
fail() { exit 31; }
hex() { bytes=$(od -An -v -tx1) || fail; printf '%s' "$bytes" | tr -d ' \n'; }
[ -n "$HOME" ] && [ -d "$HOME" ] && [ -r "$HOME" ] && [ -x "$HOME" ] || fail
home=$(readlink -f "$HOME") || fail
[ "$home" = "$HOME" ] || fail
uid=$(id -u) || fail
root="$HOME/.zcode/server"
status_file="$root/run/status.json"
status_snapshot() (
 for d in "$HOME/.zcode" "$root" "$root/run"; do
  if [ ! -e "$d" ] && [ ! -L "$d" ]; then printf '-'; return; fi
  [ ! -L "$d" ] && [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || fail
  [ "$(stat -c %u "$d")" = "$uid" ] || fail
 done
 if [ ! -e "$status_file" ] && [ ! -L "$status_file" ]; then printf '-'; return; fi
 [ ! -L "$status_file" ] && [ -f "$status_file" ] && [ -r "$status_file" ] || fail
 [ "$(stat -c %u "$status_file")" = "$uid" ] || fail
 hex < "$status_file"
)
before=$(status_snapshot) || fail
native='-'
if [ "$before" != '-' ]; then
 native_available=1
 for d in "$root/agents" "$root/agents/${ZCODE_AGENT_RUNTIME.bundledResourceDir}"; do
  if [ ! -e "$d" ] && [ ! -L "$d" ]; then native_available=0; break; fi
  [ ! -L "$d" ] && [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || fail
  [ "$(stat -c %u "$d")" = "$uid" ] || fail
 done
 if [ "$native_available" = 1 ]; then
  native_path="$root/${nativeSegments.join("/")}"
  if [ -e "$native_path" ] || [ -L "$native_path" ]; then
   [ -f "$native_path" ] && [ -r "$native_path" ] && [ -x "$native_path" ] || fail
   [ "$(stat -c %u "$native_path")" = "$uid" ] || fail
   canonical_native=$(readlink -f "$native_path") || fail
   [ "$canonical_native" = "$native_path" ] || fail
   native=$(printf '%s' "$canonical_native" | hex)
  fi
 fi
fi
printf 'META\t%s\t%s\t%s\t%s\n' "$uid" "$(printf '%s' "$home" | hex)" "$(printf '%s' "$root" | hex)" "$native"
printf 'STATUS_BEFORE\t%s\n' "$before"
proc_row() (
 tag=$1; pid=$2; p="/proc/$pid"
 [ -r "$p/stat" ] && [ -r "$p/cmdline" ] && [ -r "$p/comm" ] || fail
 raw_stat=$(cat "$p/stat") || fail
 fields=$(printf '%s' "$raw_stat" | sed 's/^.*) //' | awk '{print $2" "$20}') || fail
 set -- $fields; [ "$#" = 2 ] || fail
 ppid=$1; ticks=$2
 proc_uid=$(stat -c %u "$p") || fail
 exe=$(readlink "$p/exe") || fail
 cwd=$(readlink "$p/cwd") || fail
 comm=$(cat "$p/comm") || fail
 [ "$comm" = zcode-cli ] || comm=other
 argv_facts=$(awk -v core_entry="$runtime_dir/server-core.js" -v supervisor_entry="$runtime_dir/server-cli.js" '
  BEGIN { RS="\0" }
  length($0) { n++; if($0=="zcode-cli") title=n; if(previous=="app-server" && $0=="--stdio") legacy=n; if($0==core_entry) core=n; if($0==supervisor_entry) supervisor=n; if($0=="serve") serve=n; if($0=="--supervisor") supervised=n; previous=$0 }
  END { printf "%d,%d,%d,%d,%d,%d,%d", n,title,legacy,core,supervisor,serve,supervised }
 ' "$p/cmdline") || fail
 printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$tag" "$pid" "$ppid" "$proc_uid" "$ticks" "$(printf '%s' "$exe" | hex)" "$(printf '%s' "$cwd" | hex)" "$argv_facts" "$comm"
)
if [ "$before" != '-' ]; then
 core=$(sed -n 's/^[[:space:]]*"pid":[[:space:]]*\([0-9][0-9]*\)[,[:space:]]*$/\1/p' "$status_file") || fail
 if [ -n "$core" ]; then
  case "$core" in *[!0-9]*) fail;; esac
  core_exe=$(readlink "/proc/$core/exe") || fail
  runtime_dir=$(dirname "$core_exe") || fail
  core_stat=$(cat "/proc/$core/stat") || fail
  parent=$(printf '%s' "$core_stat" | sed 's/^.*) //' | awk '{print $2}') || fail
  proc_row CORE_BEFORE "$core" || fail
  proc_row PARENT_BEFORE "$parent" || fail
  process_table=$(ps -eo pid=,ppid=) || fail
  candidates=$(printf '%s\n' "$process_table" | awk -v parent="$core" '$2==parent {print $1}') || fail
  for pid in $candidates; do proc_row AGENT_BEFORE "$pid" || fail; proc_row AGENT_AFTER "$pid" || fail; done
  proc_row CORE_AFTER "$core" || fail
  proc_row PARENT_AFTER "$parent" || fail
 fi
fi
after=$(status_snapshot) || fail
printf 'STATUS_AFTER\t%s\nEND\n' "$after"
`;

interface ProcessEvidence {
  pid: number;
  ppid: number;
  uid: number;
  startTicks: number;
  executable: string;
  cwd: string;
  kind: string;
  comm: string;
  argvFacts: number[];
}
interface CoreStatus {
  pid: number | null;
  state: string;
  generation: number;
}
const fail = (stage: string): never => {
  throw new Error(`Remote Agent evidence: ${stage}`);
};
function integer(value: string, zero = false): number {
  if (!/^\d+$/u.test(value)) return fail("invalid-number");
  const result = Number(value);
  return Number.isSafeInteger(result) && (zero ? result >= 0 : result > 0)
    ? result
    : fail("invalid-number");
}
function decode(value: string): string {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) return fail("invalid-encoding");
  const bytes = Buffer.from(value, "hex"),
    result = bytes.toString("utf8");
  if (!Buffer.from(result).equals(bytes) || bytes.some((byte) => byte < 32 || byte === 127))
    return fail("invalid-encoding");
  return result;
}
function path(value: string): string {
  const result = decode(value);
  return posix.isAbsolute(result) && posix.normalize(result) === result
    ? result
    : fail("invalid-path");
}
function status(value: string): CoreStatus | null {
  if (value === "-") return null;
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) return fail("invalid-status");
  let parsed: unknown;
  // status.json 是已有公开身份文件，输出仅在本地解析，不落盘自由错误字段。
  const bytes = Buffer.from(value, "hex"),
    text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) return fail("invalid-status");
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("invalid-status");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("pid" in parsed) ||
    !("state" in parsed) ||
    !("generation" in parsed)
  )
    return fail("invalid-status");
  const { pid, state, generation } = parsed;
  if (
    (pid !== null && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)) ||
    typeof state !== "string" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return fail("invalid-status");
  return { pid, state, generation };
}
function processRow(row: string[]): ProcessEvidence {
  if (row.length !== 9 || !["zcode-cli", "other"].includes(row[8]!)) return fail("invalid-process");
  const argvFacts = row[7]!.split(",").map((value) => integer(value, true));
  const [count, title, legacy, core, supervisor, serve, supervised] = argvFacts;
  if (
    argvFacts.length !== 7 ||
    !count ||
    argvFacts.slice(1).some((index) => index > count) ||
    new Set(argvFacts.slice(1).filter(Boolean)).size !==
      argvFacts.slice(1).filter(Boolean).length ||
    legacy === 1
  )
    return fail("invalid-argv");
  const kind =
    count === 1 && title === 1
      ? "title"
      : legacy
        ? "legacy"
        : core
          ? "core"
          : supervisor && serve && supervised
            ? "supervisor"
            : "other";
  return {
    pid: integer(row[1]!),
    ppid: integer(row[2]!),
    uid: integer(row[3]!, true),
    startTicks: integer(row[4]!),
    executable: path(row[5]!),
    cwd: path(row[6]!),
    kind,
    comm: row[8]!,
    argvFacts,
  };
}

export function parseRemoteAgentProcessEvidence(
  stdout: string,
): Array<{ pid: number; ppid: number; startTicks: number; cwd: string }> {
  if (Buffer.byteLength(stdout) > 1024 * 1024) return fail("oversized-snapshot");
  const rows = stdout
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
  const meta = rows.shift(),
    first = rows.shift(),
    end = rows.pop(),
    last = rows.pop();
  if (
    !meta ||
    meta.length !== 5 ||
    meta[0] !== "META" ||
    first?.length !== 2 ||
    first[0] !== "STATUS_BEFORE" ||
    last?.length !== 2 ||
    last[0] !== "STATUS_AFTER" ||
    end?.length !== 1 ||
    end[0] !== "END"
  )
    return fail("invalid-snapshot");
  const uid = integer(meta[1]!, true),
    home = path(meta[2]!),
    root = path(meta[3]!);
  if (root !== posix.join(home, ".zcode/server")) return fail("invalid-root");
  const native = meta[4] === "-" ? null : path(meta[4]!);
  if (native !== null && native !== posix.join(root, ...nativeSegments))
    return fail("invalid-native");
  const before = status(first[1]!),
    after = status(last[1]!);
  if (JSON.stringify(before) !== JSON.stringify(after)) return fail("core-drift");
  if (before === null || (before.state === "stopped" && before.pid === null)) {
    if (rows.length) return fail("unexpected-process");
    return [];
  }
  if (before.state !== "ready" || before.pid === null) return fail("core-not-ready");
  const take = (tag: string) => {
    const row = rows.shift();
    if (row?.[0] !== tag) return fail("invalid-snapshot");
    return processRow(row);
  };
  const core = take("CORE_BEFORE"),
    parent = take("PARENT_BEFORE");
  if (
    core.pid !== before.pid ||
    core.uid !== uid ||
    core.kind !== "core" ||
    core.ppid !== parent.pid ||
    parent.uid !== uid ||
    parent.kind !== "supervisor" ||
    parent.executable !== core.executable ||
    !/^releases\/[^/]+\/runtime\/node$/u.test(posix.relative(root, core.executable))
  )
    return fail("invalid-core");
  const result: Array<{ pid: number; ppid: number; startTicks: number; cwd: string }> = [],
    seen = new Set<number>();
  while (rows[0]?.[0] === "AGENT_BEFORE") {
    const candidate = take("AGENT_BEFORE"),
      current = take("AGENT_AFTER");
    if (JSON.stringify(candidate) !== JSON.stringify(current) || seen.has(candidate.pid))
      return fail("process-drift");
    seen.add(candidate.pid);
    if (candidate.ppid !== core.pid || candidate.uid !== uid || candidate.kind === "other")
      continue;
    if (candidate.kind !== "title" && candidate.kind !== "legacy") return fail("invalid-agent");
    const node = candidate.executable === core.executable;
    if (
      (candidate.kind === "title" && (candidate.comm !== "zcode-cli" || !node)) ||
      (candidate.kind === "legacy" && !node && candidate.executable !== native)
    )
      return fail("invalid-executable");
    result.push({
      pid: candidate.pid,
      ppid: candidate.ppid,
      startTicks: candidate.startTicks,
      cwd: candidate.cwd,
    });
  }
  if (
    JSON.stringify(take("CORE_AFTER")) !== JSON.stringify(core) ||
    JSON.stringify(take("PARENT_AFTER")) !== JSON.stringify(parent) ||
    rows.length
  )
    return fail("core-drift");
  return result;
}
