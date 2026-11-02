import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_INSTALL_SCRIPT } from "../src/main/github-update/macInstaller.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ycode-install '$() "));
  roots.push(root);
  const target = join(root, "YCode.app");
  const work = join(root, ".update");
  const staged = join(work, "YCode.app");
  await mkdir(target);
  await mkdir(staged, { recursive: true });
  await writeFile(join(target, "version"), "old");
  await writeFile(join(staged, "version"), "new");
  const script = join(work, "install.sh");
  await writeFile(script, MAC_INSTALL_SCRIPT);
  const opener = join(root, "open.sh");
  await writeFile(opener, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$0.log"\n', { mode: 0o700 });
  return { root, target, work, staged, script, opener };
}
function run(f: Awaited<ReturnType<typeof fixture>>, pid: number, timeout = 120) {
  const child = spawn("/bin/sh", [
    f.script,
    f.target,
    f.staged,
    String(pid),
    f.work,
    join(f.root, "install.log"),
    f.opener,
    String(timeout),
  ]);
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, ready, exited };
}

describe.skipIf(process.platform === "win32")("macOS 安装助手实际文件交接", () => {
  it("旧 Main 存活时不替换，退出后替换并启动；特殊路径不参与 shell 求值", async () => {
    const f = await fixture();
    const old = spawn("/bin/sleep", ["30"]);
    try {
      const install = run(f, old.pid!);
      await install.ready;
      expect(await readFile(join(f.target, "version"), "utf8")).toBe("old");
      old.kill();
      expect(await install.exited).toBe(0);
      expect(await readFile(join(f.target, "version"), "utf8")).toBe("new");
      expect(await readFile(`${f.opener}.log`, "utf8")).toBe(`${f.target}\n`);
    } finally {
      old.kill();
    }
  });
  it("等待退出超时保留旧包且不启动", async () => {
    const f = await fixture();
    expect(await run(f, process.pid, 0).exited).not.toBe(0);
    expect(await readFile(join(f.target, "version"), "utf8")).toBe("old");
    await expect(readFile(`${f.opener}.log`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("移入新版失败时恢复并启动旧包", async () => {
    const f = await fixture();
    await rm(f.staged, { recursive: true });
    expect(await run(f, 99999999).exited).not.toBe(0);
    expect(await readFile(join(f.target, "version"), "utf8")).toBe("old");
    expect(await readFile(`${f.opener}.log`, "utf8")).toBe(`${f.target}\n`);
  });
  it("新版启动命令失败时恢复旧包", async () => {
    const f = await fixture();
    await writeFile(f.opener, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect(await run(f, 99999999).exited).not.toBe(0);
    expect(await readFile(join(f.target, "version"), "utf8")).toBe("old");
  });
});
