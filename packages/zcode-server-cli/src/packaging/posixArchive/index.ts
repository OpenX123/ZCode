import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { c as createTar } from "tar";
import type { CreatePosixReleaseArchive } from "./contract.js";

export type { PosixReleaseArchiveOptions } from "./contract.js";

const EXECUTABLE_PATHS = new Set([
  "bin/zcode",
  "runtime/node",
  "runtime/tools/bfs/bfs",
  "runtime/tools/ripgrep/rg",
  "runtime/tools/ugrep/ugrep",
  "runtime/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
  "runtime/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
]);

export const createPosixReleaseArchive: CreatePosixReleaseArchive = async (options) => {
  const root = resolve(options.releaseDir);
  const archivePath = resolve(options.archivePath);
  const outputRelative = relative(root, archivePath);
  if (!outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative)) {
    throw new Error("POSIX release archive output must be outside its input root");
  }
  const releaseName = basename(root);
  if (
    options.layout === "release" &&
    !/^zcode-server-(?:linux|darwin)-(?:x64|arm64)$/u.test(releaseName)
  ) {
    throw new Error(`Invalid POSIX release root: ${releaseName}`);
  }
  const prefix = options.layout === "release" ? `${releaseName}/` : "";
  const archive = createTar(
    {
      cwd: options.layout === "release" ? dirname(root) : root,
      gzip: true,
      portable: true,
      follow: true,
      onWriteEntry(entry) {
        if (!entry.stat) throw new Error(`Missing archive entry stat: ${entry.path}`);
        const path = entry.path.replace(/\\/gu, "/").replace(/^\.\//u, "");
        const rolePath = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        // Bug 原因：NTFS chmod/stat 没有 POSIX 执行位；必须在最终 header 按发行角色赋权，
        // 让完整包、组件和派生 B 共用同一合同，同时不把配置/JS/动态库提升成可执行文件。
        const mode = entry.type === "Directory" || EXECUTABLE_PATHS.has(rolePath) ? 0o755 : 0o644;
        entry.stat.mode = (entry.stat.mode & ~0o7777) | mode;
      },
    },
    [options.layout === "release" ? releaseName : "."],
  );
  await pipeline(archive, createWriteStream(archivePath), { signal: options.signal });
};
