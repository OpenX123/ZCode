# YCode data root

用户级数据根 `<base>/.ycode`（Beta 为 `.ycode-beta`）与旧 `<base>/.zcode` 的解析、迁移决策和 `YCODE_*` 环境变量别名的唯一来源。规则见 `docs/desktop/ycode-data-dir-migration.md`。

- `contract.ts` 为纯函数：目录名决策 `chooseDataRootDirName`、迁移计划 `planDataDirMigration`、`readYCodeEnv`（先 `YCODE_` 后 `ZCODE_`）、`applyYCodeEnvAliases`（把已设置的 `YCODE_X` 写入 `ZCODE_X`，`ENV` 不写回）。
- `node.ts` 为 Node-only 同步 fs：`resolveYCodeDataRoot` 只在结果稳定（新目录存在或旧目录存在）时缓存；`migrateLegacyDataDirSync` 只做 rename + 链接，失败保持旧目录可用，不复制数据，成功后清空缓存。
- 迁移的触发时机只属于 Desktop main 启动早期；其它进程只解析，不迁移。项目级 `<workspace>/.zcode/` 不经此模块。
