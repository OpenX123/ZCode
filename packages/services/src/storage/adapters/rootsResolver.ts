/**
 * 数据根解析：R1 = 家目录下的 .ycode（未迁移时为 .zcode），R2 = 自定义数据存储路径下的同名目录（仅当设置了且 ≠ 家目录）。
 * 统计真实目录而非 .zcode 链接，否则 junction/symlink 会让占用显示为 0。
 * 路径来源由调用方注入（desktop host 传 homedir 与 getDataBaseDir），模块内不读环境变量。
 */
import { resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";
import { resolveYCodeDataRoot } from "@zcode/shared/ycode-data-root";

export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): StorageRootSpec[] {
  const home = resolve(params.homeDir);
  const dataBase = resolve(params.dataBaseDir);
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    { id: "home", path: resolveYCodeDataRoot(home), hasCustomDataBaseDir },
  ];
  if (hasCustomDataBaseDir) {
    roots.push({
      id: "dataBaseDir",
      path: resolveYCodeDataRoot(dataBase),
      hasCustomDataBaseDir,
    });
  }
  return roots;
}

export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () =>
      resolveStorageRoots({ homeDir: params.getHomeDir(), dataBaseDir: params.getDataBaseDir() }),
  };
}
