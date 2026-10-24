import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanDist } from "../../apps/zcode-cli/scripts/clean-dist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compiler = join(repoRoot, "apps/zcode-cli/node_modules/typescript/bin/tsc");

test("删除源文件后清理当前包再构建，整包暂存不携带退休产物", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-clean-build-"));
  const packageDirectory = join(root, "contracts");
  const src = join(packageDirectory, "src");
  const dist = join(packageDirectory, "dist");
  try {
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "retired.ts"), "export const retired = true;\n");
    await writeFile(join(src, "current.ts"), "export const current = true;\n");
    await writeFile(
      join(packageDirectory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { rootDir: "src", outDir: "dist", types: [], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    );
    const build = () => {
      const result = spawnSync(process.execPath, [compiler], {
        cwd: packageDirectory,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    build();
    await rm(join(src, "retired.ts"));
    build();
    // tsc 成功仍遗留旧输出，证明不能用构建成功代替清理。
    await access(join(dist, "retired.js"));
    const dependency = join(root, "built-dependency", "dist");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "index.js"), "dependency-output");
    await cleanDist(packageDirectory);
    build();
    await cp(packageDirectory, join(root, "staged-contracts"), { recursive: true });
    await assert.rejects(access(join(root, "staged-contracts", "dist", "retired.js")));
    await access(join(root, "staged-contracts", "dist", "current.js"));
    assert.equal(await readFile(join(dependency, "index.js"), "utf8"), "dependency-output");
    await access(join(src, "current.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("原有 clean 命令仍按调用包目录清理 dist", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-clean-command-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "keep.txt"), "keep");
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "apps/zcode-cli/scripts/clean-dist.mjs")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(join(root, "dist")));
    await access(join(root, "keep.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
