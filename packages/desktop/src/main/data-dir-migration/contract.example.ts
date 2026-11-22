import { shouldAllowDataDirRename } from "./contract.js";

/** 示例：打包版正常启动允许迁移；带 ZCODE_DATA_BASE_DIR 的开发隔离不迁移。 */
export function exampleAllowRename(): [boolean, boolean] {
  return [
    shouldAllowDataDirRename({ env: {}, isPackaged: true }),
    shouldAllowDataDirRename({ env: { ZCODE_DATA_BASE_DIR: "/tmp/dev-home" }, isPackaged: true }),
  ];
}
