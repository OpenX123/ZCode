# Desktop data dir migration

Desktop main 是本机 `~/.zcode` → `~/.ycode` 迁移的唯一触发者，规则见 `docs/desktop/ycode-data-dir-migration.md`。

- `early.ts` 必须是 `packages/desktop/src/main/index.ts` 的第一条 import，且只依赖 Node 内置模块、`electron` 与 `@zcode/shared/ycode-data-root`，保证先于 services、logger、`setting.json` 读取与任何子进程。
- 候选 base：home（`os.homedir()`、`HOME`、`USERPROFILE` 去重）与 `setting.json` 的 `dataBaseDir`；来自环境变量的数据目录（开发/E2E 隔离）不加入。
- 只在打包版且非隔离环境允许 rename；开发版可用 `YCODE_DATA_DIR_MIGRATION=1` 开启。全新目录的建目录与补链接不受限制。
- 迁移结果先缓存，logger 就绪后由 `logEarlyDataDirMigrationReport` 输出；本模块不导入 logger，避免日志目录在 rename 前被创建或占用。
