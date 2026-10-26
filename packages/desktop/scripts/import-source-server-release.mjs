#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { sourceServerReleaseDescriptorSchema } from "@zcode/shared/source-server-release";

export async function importSourceServerRelease({ descriptorPath, archivePath, cacheDir }) {
  const descriptorStat = await lstat(descriptorPath);
  if (!descriptorStat.isFile() || descriptorStat.size > 64 * 1024) {
    throw new Error("资源清单必须是小于 64 KiB 的普通文件");
  }
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(descriptorPath, "utf8")),
  );
  // 版本来自外部文件，不允许它作为路径段逃逸 Host 缓存根目录。
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(descriptor.version)) {
    throw new Error("资源清单版本不能包含路径分隔符");
  }
  const archive = descriptor.archives.find((item) => item.fileName === basename(archivePath));
  if (!archive) throw new Error("资源清单未声明此归档文件");
  if (!(await lstat(archivePath)).isFile()) throw new Error("资源归档必须是普通文件");
  const destinationDir = join(
    resolve(cacheDir),
    "source-server",
    descriptor.version,
    archive.target,
    archive.sha256,
  );
  await mkdir(destinationDir, { recursive: true });
  const destination = join(destinationDir, archive.fileName);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(archivePath, temporary);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    if (
      (await stat(temporary)).size !== archive.sizeBytes ||
      hash.digest("hex") !== archive.sha256
    ) {
      throw new Error("资源归档大小或 SHA-256 与清单不一致");
    }
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      descriptor: { type: "string" },
      archive: { type: "string" },
      "cache-dir": { type: "string" },
    },
  });
  if (!values.descriptor || !values.archive || !values["cache-dir"]) {
    throw new Error(
      "用法：node packages/desktop/scripts/import-source-server-release.mjs --descriptor <json> --archive <tar.gz> --cache-dir <remote-assets-cache>",
    );
  }
  const destination = await importSourceServerRelease({
    descriptorPath: resolve(values.descriptor),
    archivePath: resolve(values.archive),
    cacheDir: resolve(values["cache-dir"]),
  });
  process.stdout.write(`已校验并导入：${destination}\n`);
}
