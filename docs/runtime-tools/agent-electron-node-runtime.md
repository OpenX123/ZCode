# ZCode Agent 用「已有 Node + 编译产物 zcode.cjs」运行（桌面 & 远端）

## 核心思路

ZCode Agent 以前每个平台都内置一份独立的原生二进制 `zcode-agent`（SEA：官方 Node + `zcode.cjs` + TUI 资源 + 官方插件），单平台 ~180MB，里面**自带一份 Node**。

但无论桌面还是远端，运行 agent 的环境里**本来就已经有一份 Node**：

- **桌面**：Host 跑在 Electron `utilityProcess`，`process.execPath` 指向 Electron Helper，内置 Node 24.x（Electron 41）。
- **远端 SSH/WSL/Docker**：Source Server archive 自带目标 Node，并用它运行 Server CLI/Core 与 `zcode.cjs`。

所以 agent 没必要再带一份 Node，直接用这份已有的 Node 执行编译产物 `zcode.cjs` 即可。

Agent 主入口 `zcode.cjs` 是本仓库源码打出的 Node bundle；桌面与远端复用同一份入口。运行时资产还包含随包插件、Skills 及插件需要的原生依赖，不能仅凭主入口是 JS 就省略平台资源。打包脚本会为目标平台 stage 所需资产，包括当前插件使用的 Sharp / Koffi。

原 Node bundle 改造时的体积估算为单平台约 180MB 降至约 16MB；当前完整资产体积还取决于随包插件及平台依赖，应以本次构建结果为准。桌面与远端继续共享 Agent 主入口形态。

## 运行方式

**桌面**（`zcodeAgentProcessManager.ts: resolveElectronRuntimeZCodeAgentCommand`，`process.versions.electron` 为闸门）：

```
process.execPath  <Electron Helper>
  args: [resources/glm/zcode.cjs, app-server, --stdio]
  env:  { ELECTRON_RUN_AS_NODE: "1" }   // 必须，否则子进程被当成 Chromium 子进程卡在 GPU 初始化
```

**远端**：完整 archive 将 `zcode.cjs` 放入 immutable release 的 `runtime/`，Server Core 按 release manifest 创建 Workspace Agent；不再向 `~/.zcode/server/agents/glm/` 部署散文件或 wrapper。

## 实现

**bundle 目标版本**（`apps/zcode-cli/packages/cli/scripts/build.mjs`）
esbuild `target` 从 `node26` 降到 **`node22`**，取两端运行时里最低的 Node 版本（远端 v22.16）。保证同一份 `zcode.cjs` 在桌面 Node 24 和远端 Node 22 上都不会用到目标运行时不支持的语法。

**桌面**

- `zcode-agent-runtime.ts`：描述符加 `nodeBundleEntryFile: "zcode.cjs"` + `resolveNodeBundleSegments()`。
- `providerRuntimeResolver.ts`：`findZCodeAgentRuntimeNodeBundle()` 定位 `resources/glm/zcode.cjs`。
- `zcodeAgentProcessManager.ts`：`resolveElectronRuntimeZCodeAgentCommand` 使用当前随包 Node bundle；开发与打包都以本仓库构建产物为准。
- 打包：`prepare:agent-bundle`（`prepare-agent-node-bundle.mjs`）构建 cli、把 `zcode.cjs` stage 进 `bundled-agents/<平台>/glm/`、删掉旧原生 `zcode-agent`；`prepare:runtime-assets` 调用该源码准备步骤；electron-builder 整目录拷 `resources/glm`。

**远端**

- `@zcode/server-cli stage:remote-assets` 为四个平台生成完整 archive；`runtime/zcode.cjs` 与 Server CLI/Core 使用同一 descriptor SHA 身份。
- 本仓库构建的完整 archive 从本地 staging 资源进入 SSH 部署，最终通过既有 `zcode update --from-archive` 安装；缺少源码产物时明确失败，不回退原厂 CDN 或二进制。
- legacy `prepare-prebuilds.mjs`、component manifest 与散文件部署不再进入开发、CI 或发布链路。

## 历史验证（Node bundle 改造）

- `tsc -b packages/rpc packages/shared packages/services packages/server` 通过；`oxlint` 改动文件 0/0。
- cli 以 `target node22` 重新构建成功（dist/zcode.cjs 15.7MB）。
- 冒烟：`node dist/zcode.cjs app-server --stdio` 在纯 Node 下正常启动并维持 stdio 服务（stdin EOF 时干净退出 0），证明编译产物脱离 SEA、脱离 Electron 也能跑——即远端 wrapper 的运行形态。
- 上述结果是原 Node bundle 改造的历史验证记录；独立桌面版本的安装包启动、SSH 资源完整性及真实 API 验收分别记录在独立桌面规格中，不能由历史记录推定通过。

## 备注

2026-10-24 独立桌面版本已删除 `scripts/download-glm.mjs` 与 desktop `prepare:glm`，不提供下载原厂 Agent 的手动兜底。

- 桌面：`pnpm --filter @zcode/desktop prepare:agent-bundle` 从本仓库源码构建并 stage Agent。
- SSH：`pnpm prepare:remote-assets` 从本仓库源码构建 Server / Agent 并生成完整目标平台 archive。
- Node 与第三方运行时资源由既有打包脚本准备；它们与原厂 Agent 二进制是不同的供应链来源。缺失资产必须修复构建，不得恢复已退出的官方下载路径。
