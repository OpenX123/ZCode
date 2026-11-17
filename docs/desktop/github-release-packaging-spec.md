# GitHub 桌面与远程资源发布规格

## 目标与边界

GitHub Actions 为 Windows/macOS 的 ARM64、x64 构建桌面安装包；远程 Source Server 归档从桌面安装包移出，四个桌面目标共享同轮生成的四目标 descriptor。普通本地构建默认继续携带完整离线资源；仅设置 `ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY=1` 的发行构建启用轻量模式。

## 发布身份与唯一所有者

- 资源 job 是本轮 Source Server 归档与 descriptor 的唯一生成者，使用现有 `prepare:remote-assets` 一次生成四个目标；桌面 job 不重新生成资源。
- 正式应用版本从 `1.0.0` 起。仅 main 的 `workflow_dispatch` 是正式发版入口，push / PR 不发版；路径过滤与操作入口见 [GitHub 桌面构建与发布](github-release-spec.md)。每轮新的正式构建由资源 job 唯一分配版本：查询本仓库全部 `v1.0.<patch>` Git 标签，无则使用 `1.0.0`，否则使用最大 patch 加一；标签为 `v<version>`。正式发版使用独立于 push / PR 的并发组，同组串行且不取消正在执行的正式构建，避免同一版本被并发分配。
- 版本分配后只在 CI 工作区更新根 `package.json`；四种桌面目标与最终发布 job 从同一资源 job 输出恢复版本，不重新计算。Desktop metadata、Vite、Host、Server 编译常量及资源目录从根版本派生，独立 Agent CLI 包版本不在此流程修改。
- `rerun failed jobs` 继续使用先前成功资源 job 的版本与清单；重跑全部 job 时重新查询标签。完整性校验后通过 GitHub Git refs API 原子创建 `v1.0.N` 指向当前提交，再用 `--verify-tag` 创建 draft；即使后续上传失败，标签也已占用，下一轮自动跳到新 patch。已公开版本和已占用标签不得覆盖，失败不公开 Release。
- 若失败发生在标签占用后，仅重跑 publish 会明确失败并提示重跑全部 job 分配新 patch；不自动删除或覆盖旧标签、草稿或附件，不能把半成品当作最新正式版本。
- push、PR 和非 main 的手动运行使用当前根版本和临时 `build-<run_number>-<run_attempt>` 身份，不分配或发布正式版本。历史 `build-*` Release 的资源 URL 保持有效；正式 descriptor 将 archive URL 固定到本仓库 `v1.0.N` 标签下，不能运行时用 `latest` 选择远程资源。
- descriptor 沿用共享 schema，包含当前版本、四个唯一目标、文件名、字节数和 SHA-256；固定 URL 前必须验证本轮真实归档。桌面 job 下载同一份 descriptor，并再次验证版本、完整目标与固定 URL。
- `node scripts/github-release-assets.mjs` 是 CI 的实际入口；脚本经 Desktop 依赖解析共享包的公开 `@zcode/shared/source-server-release`，再使用仓库已有 `tsx/esm/api` 加载 TypeScript 及其 `.js` 源码引用，不依赖 Node 原生类型擦除提供扩展名映射。共享 schema 仍是唯一校验所有者，不复制 schema、不修改生产导入或 workflow 启动命令，也不把工具 loader 放入产品 bundle。
- 独立远程附件继续执行每目标 112 MiB、总量 400 MiB 的资源预算；拆出桌面包不意味着放宽远程附件限制。
- 同一次发布收集四个远程归档、一份 descriptor、macOS 两个架构的 DMG/ZIP 和 Windows 两个架构的 EXE，先验证十一项输入，再从真实安装包生成 `ycode-update.json`；完整性与摘要检查通过后创建 draft Release，上传全部附件和校验清单，最后公开。
- 更新清单格式为 `{schemaVersion:1,version,releaseUrl,assets}`。`assets` 精确包含 darwin/win32 的 arm64/x64 四种目标；各项字段为 `platform`、`arch`、`fileName`、`url`、`size`、`sha256`，macOS 使用 DMG、Windows 使用 EXE。URL 固定当前 Release，size/SHA 从本轮真实文件生成。
- `SHA256SUMS` 覆盖六安装包、四远程归档、descriptor 和更新清单十二件内容。正式 Release 总计十三附件；GitHub `latest/download/ycode-update.json` 只用于发现最新应用版本，远程资源下载仍固定应用随包 descriptor。
- 不覆盖已公开的 Release、同名 Git 标签或失败草稿；检测到冲突时失败，不能静默 `--clobber`。

## 构建顺序

- 本地完整模式继续先构建远程服务，再准备桌面 Agent 与插件，避免 Server 构建清空刚生成的桌面 Agent 暂存目录。
- 轻量模式必须先下载并校验 descriptor，然后只准备当前桌面目标的本地 Agent、插件、原生工具和 helper。
- bundle 统一执行一次 `prepare:runtime-assets`，后续仅调用 `build:no-runtime-assets`；`--skip-prepare` 不允许经 build 再次隐式准备资源。
- 轻量 `extraResources` 只复制 `releases/<version>/source-server-release.json`，不携带任何远程 tar；本地运行依赖和现有原生资源不受此开关影响。
- 未被路径过滤的 push / PR 同样生成资源并构建四种桌面目标，但不公开 Release；其临时 descriptor 只用于验证打包，不能当作正式可下载产品分发。

```mermaid
flowchart TD
    A[固定工具链与独立正式发版并发组] --> A1{main 手动运行?}
    A1 -- 是 --> A2[读取正式标签并分配下一 patch]
    A1 -- 否 --> A3[使用临时构建身份]
    A2 --> B[根版本同步后一次生成四目标]
    A3 --> B
    B --> C[验证归档并固定本轮 Release URL]
    C --> D[上传四归档与 descriptor artifact]
    D --> E[四桌面 job 下载同一 descriptor]
    E --> F[同步根版本、校验 descriptor 并准备本机 Agent]
    F --> G[构建桌面并仅打包 descriptor]
    G --> H[最终安装器体积与依赖检查]
    H --> I{main 手动运行?}
    I -- 否 --> J[保留 CI artifacts]
    I -- 是 --> K[汇总并校验六安装包与四归档]
    K --> K1[生成四目标更新清单与校验摘要]
    K1 --> K2[Git refs API 原子占用正式版本标签]
    K2 --> L[verify-tag 创建不可覆盖的 draft Release]
    L --> M[上传全部附件与 SHA256SUMS 后公开]
```

## 验收

- 缺少目标、同目标重复、归档 SHA/size 错误、URL 指向其他发布或版本不匹配，均终止构建或发布。
- 固定 Node 24.14.0 下以不带 loader 参数、无继承 `NODE_OPTIONS` 的真实 Node 子进程执行上述入口，使用本地四归档 fixture 完成 `pin --directory ... --output ...` 并核对复制文件、摘要及固定 URL；测试不得替换共享模块、访问网络或执行发布操作。
- 轻量包中 remote-assets 只能存在当前 descriptor；最终安装器按独立固定预算审计，不再按远程归档字节增加额度。
- 脚本测试覆盖首次 1.0.0、最大 patch 递增、标签过滤、跨 job 版本恢复、固定 URL、旧 build URL、篡改与缺件、六安装包完整性、四目标更新清单与摘要；安装器运行行为由安装态 smoke 与远程连接回归验证。
- 生产 Release 资产齐全且可下载才算发布完成；Actions 成功不替代各平台已安装应用的运行验证。

## Task36 纯发布工具增量的验证边界

仅本次 Node loader 修复允许携带既有本地应用候选证据。相对已推送 `76be2adf3994cd3a17691796c51943e6542e708e`，新 HEAD 的 tracked 差异必须精确为以下四文件；不得通过重设 BASE、伪 HEAD、跳过 hook 或修改门禁取得通过：

- `scripts/github-release-assets.mjs`
- `scripts/test/github-release-assets.test.mjs`
- `docs/desktop/github-release-packaging-spec.md`
- `docs/superpowers/plans/2026-11-16-release-gate-repair.md`

相对原本地候选 `f7c38cbe78e14226a487dac62822db202e4d5e98` 的严格等价 allowlist 精确为上述四文件，加 Task35 的以下三文件（本计划已包含在上述四文件中，合计七文件）：

- `docs/testing/1.4.1-gate-repair-spec.md`
- `packages/ui/test/v4ConversationStatusPanelGitReview.test.ts`
- `packages/services/test/zcodeStdioTransport.processTree.test.ts`

验证须逐项比较全部其余 tracked tree 的 path、mode、type、blob，新增、删除、mode 或子模块变化也必须拒绝；任何其它差异或生产/依赖/配置变更均停止复用并重建重验。重新核验原 f7 包的五个固定 SHA、原生验收、92 项保护原件及证据哈希；保留 `buildCommit=f7`，HEAD/buildTime 等 metadata 不等价，不改旧 stamp/base/包或历史原件，不声称新 HEAD 构建或缓存命中。

原76be八步门禁、原BASE完整 pre-push 的 1128 files /12619 tests 成功与 remote SHA 原件仅作为祖先证据保留。新 HEAD 必须完成 root typecheck/lint/architecture、全部相关发布脚本测试及独立审查；随后以自然远端76be作为实际 push 的 hook 比较基线运行原 pre-push，保存自然退出与新 remote SHA 回读，不冒称新 HEAD 再跑了原1af基线全套。以上只避免无应用内容变化时重复本地打包和原生验收；正式 GitHub assets 始终必须由最终 HEAD 重构建。
