import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRemoteAgentProcesses } from "./e2e/helpers/ssh-remote-lifecycle.js";
import type { SSHConnectionConfig } from "./e2e/helpers/ssh-remote-p0.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("./e2e/helpers/ssh-remote-p0.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  runSSHCommand: transport,
}));

const config: SSHConnectionConfig = {
  host: "synthetic-host",
  port: 22,
  username: "synthetic",
  password: "fixture-only",
};
const home = "/home/zcodee2e";
const root = `${home}/.zcode/server`;
const exe = `${root}/releases/1.4.0-linux-x64-fixture/runtime/node`;
const native = `${root}/agents/glm/zcode-agent`;
const hex = (value: string) => Buffer.from(value).toString("hex");
const status = { state: "ready", pid: 7496, generation: 1 };
type Status = { state: string; pid: number | null; generation: number };
type Proc = {
  pid: number;
  ppid: number;
  uid: number;
  ticks: number;
  exe: string;
  cwd: string;
  kind: string;
  comm: string;
  argv?: string[];
};
const core: Proc = {
  pid: 7496,
  ppid: 7485,
  uid: 1001,
  ticks: 4973114,
  exe,
  cwd: home,
  kind: "core",
  comm: "other",
};
const parent: Proc = { ...core, pid: 7485, ppid: 1, ticks: 4973055, kind: "supervisor" };
const agent = (pid = 7522, cwd = `${home}/workspace-a`): Proc => ({
  ...core,
  pid,
  ppid: core.pid,
  ticks: 4973601 + pid,
  cwd,
  kind: "title",
  comm: "zcode-cli",
});
function row(tag: string, p: Proc) {
  const runtime = exe.slice(0, exe.lastIndexOf("/"));
  const argv =
    p.argv ??
    (p.kind === "core"
      ? [exe, `${runtime}/server-core.js`]
      : p.kind === "supervisor"
        ? [exe, `${runtime}/server-cli.js`, "serve", "--supervisor"]
        : p.kind === "legacy"
          ? [p.exe, `${runtime}/zcode.cjs`, "app-server", "--stdio", "--surface", "desktop"]
          : ["zcode-cli"]);
  const index = (token: string) => argv.lastIndexOf(token) + 1;
  const legacy =
    argv.findIndex((token, i) => token === "--stdio" && argv[i - 1] === "app-server") + 1;
  const facts = [
    argv.length,
    index("zcode-cli"),
    legacy,
    index(`${runtime}/server-core.js`),
    index(`${runtime}/server-cli.js`),
    index("serve"),
    index("--supervisor"),
  ].join(",");
  return [tag, p.pid, p.ppid, p.uid, p.ticks, hex(p.exe), hex(p.cwd), facts, p.comm].join("\t");
}
let before: Status | "missing";
let after: Status | "missing";
let candidates: Array<{ before: Proc; after: Proc }>;
let coreAfter: Proc;
let parentAfter: Proc;
let nativePath: string;
let overrideOutput: string | undefined;

function output() {
  const s = (value: Status | "missing") => (value === "missing" ? "-" : hex(JSON.stringify(value)));
  return (
    [
      ["META", 1001, hex(home), hex(root), nativePath ? hex(nativePath) : "-"].join("\t"),
      `STATUS_BEFORE\t${s(before)}`,
      ...(before !== "missing" && before.pid
        ? [
            row("CORE_BEFORE", core),
            row("PARENT_BEFORE", parent),
            ...candidates.flatMap((p) => [
              row("AGENT_BEFORE", p.before),
              row("AGENT_AFTER", p.after),
            ]),
            row("CORE_AFTER", coreAfter),
            row("PARENT_AFTER", parentAfter),
          ]
        : []),
      `STATUS_AFTER\t${s(after)}`,
      "END",
    ].join("\n") + "\n"
  );
}

beforeEach(() => {
  before = { ...status };
  after = { ...status };
  coreAfter = { ...core };
  parentAfter = { ...parent };
  candidates = [agent(), agent(7540, `${home}/workspace-b`)].map((p) => ({
    before: { ...p },
    after: { ...p },
  }));
  nativePath = native;
  overrideOutput = undefined;
  transport.mockReset().mockImplementation(async (_config, command: string) => ({
    code: 0,
    stderr: "",
    // 旧实现在真实 title 现场只命中查询进程；新采集器返回白名单快照，不回传完整 argv。
    stdout: command.includes("ps -eo pid=,args=")
      ? "7705\t7693\t5020821\t/\n"
      : (overrideOutput ?? output()),
  }));
});

describe("listRemoteAgentProcesses actual caller", () => {
  it("returns real title A/B identities using exactly one bounded SSH command", async () => {
    await expect(listRemoteAgentProcesses(config)).resolves.toEqual(
      candidates.map(({ before: p }) => ({
        pid: p.pid,
        ppid: p.ppid,
        startTicks: p.ticks,
        cwd: p.cwd,
      })),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe(config);
    expect(transport.mock.calls[0]).toHaveLength(2);
  });
  it("preserves legacy complete tokens with the exact Core Node", async () => {
    candidates = [
      {
        before: { ...agent(), kind: "legacy", comm: "other" },
        after: { ...agent(), kind: "legacy", comm: "other" },
      },
    ];
    expect(await listRemoteAgentProcesses(config)).toHaveLength(1);
  });
  it("preserves the descriptor's exact canonical deployed native", async () => {
    candidates = [
      {
        before: { ...agent(), kind: "legacy", exe: native },
        after: { ...agent(), kind: "legacy", exe: native },
      },
    ];
    expect(await listRemoteAgentProcesses(config)).toHaveLength(1);
  });
  it.each<[string, string[]]>([
    ["other", [exe, "unrelated"]],
    ["title-extra", ["zcode-cli", "--extra"]],
    ["app-server-suffix", [exe, "app-server-other", "--stdio"]],
    ["nonadjacent", [exe, "app-server", "extra", "--stdio"]],
    ["query-shell", ["sh", "-c", "app-server --stdio"]],
    ["query-awk", ["awk", "/app-server --stdio/ {print $1}"]],
  ])("rejects argv lookalikes: %s", async (_label, argv) => {
    const p = { ...agent(), argv };
    candidates = [{ before: p, after: { ...p } }];
    await expect(listRemoteAgentProcesses(config)).resolves.toEqual([]);
  });
  it.each(["ppid", "uid"] as const)("excludes other Core/user: %s", async (key) => {
    const p = { ...agent(), [key]: 9911 };
    candidates = [{ before: p, after: { ...p } }];
    await expect(listRemoteAgentProcesses(config)).resolves.toEqual([]);
  });
  it.each(["/tmp/node", `${root}/elsewhere/node`, `${native}-other`])(
    "fails closed on an unproven executable: %s",
    async (path) => {
      const p = { ...agent(), exe: path };
      candidates = [{ before: p, after: { ...p } }];
      await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
    },
  );
  it("rejects native realpath outside the exact supported deployment", async () => {
    nativePath = "/tmp/zcode-agent";
    const p = { ...agent(), kind: "legacy", exe: nativePath };
    candidates = [{ before: p, after: { ...p } }];
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it("rejects title without the matching comm", async () => {
    const p = { ...agent(), comm: "other" };
    candidates = [{ before: p, after: { ...p } }];
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it.each(["ticks", "ppid", "uid", "exe", "cwd"] as const)(
    "fails on candidate identity drift: %s",
    async (key) => {
      const p = agent();
      candidates = [
        { before: p, after: { ...p, [key]: typeof p[key] === "number" ? 9911 : "/different" } },
      ];
      await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
    },
  );
  it.each(["ticks", "ppid", "uid", "exe"] as const)(
    "fails on Core identity drift: %s",
    async (key) => {
      coreAfter = { ...core, [key]: typeof core[key] === "number" ? 9911 : "/different" };
      await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
    },
  );
  it("fails on supervisor identity drift", async () => {
    parentAfter.ticks++;
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it("fails on status generation drift", async () => {
    after = { ...status, generation: 2 };
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it.each([
    { state: "crashed", pid: null, generation: 1 },
    { state: "ready", pid: null, generation: 1 },
    { state: "stopped", pid: 7496, generation: 1 },
    { state: "ready", pid: 7496, generation: -1 },
  ])("rejects a non-ready or invalid status $state/$pid/$generation", async (value) => {
    before = after = value;
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid candidate startTicks %s",
    async (ticks) => {
      const p = { ...agent(), ticks };
      candidates = [{ before: p, after: { ...p } }];
      await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
    },
  );
  it("rejects a duplicate candidate birth", async () => {
    candidates.push(candidates[0]!);
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it.each(["missing", "stopped"] as const)(
    "returns empty only for explicit no-Core: %s",
    async (kind) => {
      before = after =
        kind === "missing" ? "missing" : { state: "stopped", pid: null, generation: 1 };
      await expect(listRemoteAgentProcesses(config)).resolves.toEqual([]);
    },
  );
  it("fails if a previously absent Core appears", async () => {
    before = "missing";
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
  });
  it.each(["permission", "nonmissing-io", "proc-disappeared"])(
    "rejects collection error %s without leaking stderr",
    async () => {
      transport.mockResolvedValue({ code: 31, stdout: "", stderr: "untrusted diagnostic payload" });
      await expect(listRemoteAgentProcesses(config)).rejects.toThrow(
        /^Remote Agent evidence: scan-failed$/u,
      );
    },
  );
  it("sanitizes SSH transport rejection", async () => {
    transport.mockRejectedValue(new Error("untrusted transport payload"));
    await expect(listRemoteAgentProcesses(config)).rejects.toThrow(
      /^Remote Agent evidence: scan-failed$/u,
    );
  });
  it.each(["", "META\tbad\nEND\n", "not-json", "END\n"])(
    "rejects missing/malformed evidence",
    async (value) => {
      overrideOutput = value;
      await expect(listRemoteAgentProcesses(config)).rejects.toThrow("Remote Agent evidence:");
    },
  );
  it("returns full HOME and deleted cwd without applying caller workspace filters", async () => {
    candidates = [agent(7522, home), agent(7540, `${home}/workspace-a (deleted)`)].map((p) => ({
      before: p,
      after: { ...p },
    }));
    expect((await listRemoteAgentProcesses(config)).map((p) => p.cwd)).toEqual([
      home,
      `${home}/workspace-a (deleted)`,
    ]);
  });
});
