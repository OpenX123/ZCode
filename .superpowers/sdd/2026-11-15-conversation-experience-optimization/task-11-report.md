# T11 / UX11 实施报告

## 交付状态

- 状态：DONE_WITH_CONCERNS。产品交互及目标 Windows Electron 验证通过；macOS、Linux 与真实 SSH 工作区未实测。
- 分支：`codex/conversation-experience-1.4.1`；固定起点：`9b560c7264aaee164996e18f2ed86d6cd365dba5`。
- 实现与测试提交：`e3f810668effe497648bc74482c45f8e02512971`（`feat(ui): 添加主题快捷切换与设置页窗口缩放`）。本报告单独提交，以保留实现提交的准确 SHA；均未 push。
- 开工前 `node scripts/check-workspace-freshness.mjs` 通过。按 `architecture-governance` 读取受控上下文，并先更新两份 UI spec，再写失败测试、实施代码。
- 最终检查使用 Node `24.14.0`、pnpm `10.33.2`。一次 MODE-02/03 补跑的 shell 未前置指定 Node，实际为 `24.18.0`；该轮结果单列，不冒充目标版本验证。

## 实现与规则

1. 侧栏 footer 移除滑杆快捷偏好菜单，保留设置入口与桌面更新入口，增加单击太阳/月亮主题按钮。按钮以 `resolveTheme` 解析当前深浅，展示将切换到的图标、tooltip 与 aria-label，并通过原有主题 setter 写入 `zai-light` 或 `zai-dark`。
2. System 偏好下订阅系统亮暗变化仅刷新按钮展示，不新增主题状态 owner，不写入持久化偏好。设置页仍提供 System、深浅主题、语言与界面模式；主题 store 原有广播通路继续负责跨窗口同步与回环抑制。
3. 外观设置增加桌面窗口缩小、放大、重置按钮，复用 `usePlatform()` 的 `executeDesktopCommand`、`getDesktopZoomLevel` 与 `onDesktopZoomLevelChanged`。操作依据窗口级别 -3 至 5 禁用；先订阅窗口事件，再读取初值，晚到的旧初值不覆盖事件。普通 Web 不显示该控件。未修改 UI 字号或主题 token。
4. 先更新 `docs/ui/workspace-sidebar-footer.md` 与 `docs/ui/default-theme.md`，说明状态所有者、平台接口、事件顺序和验收场景。旧 E2E 的快捷菜单断言迁移至新按钮及设置页路径。

## 测试与验证

| 阶段 | 命令或场景 | 退出码 | 关键结果 |
| --- | --- | ---: | --- |
| RED | `pnpm exec vitest run packages/ui/test/sidebarThemeShortcut.test.ts packages/ui/test/useTheme.test.ts` | 1 | 新按钮 5 项失败；原有 `useTheme` 6 项通过。 |
| RED | `pnpm exec vitest run packages/ui/test/settingsDesktopZoom.test.ts` | 1 | 新桌面缩放组件尚未存在，3 项失败。 |
| GREEN / 最终 | `pnpm exec vitest run packages/ui/test/sidebarThemeShortcut.test.ts packages/ui/test/useTheme.test.ts packages/ui/test/settingsDesktopZoom.test.ts packages/ui/test/interfaceMode.test.ts` | 0 | 4 文件、23/23 通过；有 jsdom Canvas `getContext` 未实现提示。 |
| 最终 | `pnpm typecheck` | 0 | 根类型检查通过。首次因删除 footer 旧 props 后仍有旧调用点失败，修正调用后通过。 |
| 最终 | `pnpm lint` | 0 | 91 warnings、0 errors；warning 为仓库现有项目范围。 |
| 最终 | `pnpm architecture:check --changed` | 0 | 0 violations；基线 0、新增 0。 |
| 最终 | `git diff --cached --check` | 0 | 无空白错误。 |
| 定向格式 | `pnpm exec prettier --check docs/ui/default-theme.md docs/ui/workspace-sidebar-footer.md packages/ui/src/WorkspaceSidebarFooter.tsx packages/ui/test/sidebarThemeShortcut.test.ts packages/ui/test/settingsDesktopZoom.test.ts packages/desktop/test/e2e/settings/sidebar-theme-zoom.test.ts` | 0 | 6 个文件符合格式。其余部分被修改的旧文件在固定 BASE 即不符合当前 Prettier，未整文件重排。 |

正式 Electron E2E：

| 场景 | run ID | 退出码 | 结果 |
| --- | --- | ---: | --- |
| 新 `sidebar-theme-zoom.test.ts`，完整 Desktop UI 构建 | `desktop-e2e-20261116041937504-p50848-5103e0bf10cc7d1e` | 0 | 3/3。 |
| 新场景，纯测试补证并复用相同 UI 产物 | `desktop-e2e-20261116042439023-p28128-4147743e80df696f` | 0 | 3/3；保留主题与窄窗截图、窗口几何 JSON。 |
| 迁移旧 `settings-ui-polish.test.ts` 的 UP-01 | `desktop-e2e-20261116042715975-p46800-26eed1e4957858f4` | 0 | 1/1。 |
| 迁移旧 `general-coding-mode.test.ts` 的 MODE-01 | `desktop-e2e-20261116042817345-p43540-8ce48c647ab5ea62` | 0 | 1/1。 |
| `general-coding-mode.test.ts` 全文件首轮 | `desktop-e2e-20261116042926883-p51992-bf47600d750d2c13` | 1 | MODE-01 通过、MODE-02/03 失败。目标右侧 PTY 实际是 PowerShell，旧测试 `printf` 命令无效；截图 `general-coding-mode/general-mode-pty.png` 保存了终端报错。 |
| MODE-02/03 单点补跑 | `desktop-e2e-20261116-043248-077` | 0 | 1/1。测试命令最小改为跨 shell 的 `echo MODE_PTY_ALIVE`，保留原焦点与 PTY 输出断言；未改产品代码或等待超时。 |

新场景覆盖真实 Tab / Enter / Space、Electron `nativeTheme` 深浅切换、System 偏好无额外写入、中英文按钮与设置导航、真实窗口缩放和窄窗布局。`window-zoom-layout.json` 实测 factor `1 → 1.1 → 0.9090909 → 1`、级别 `0 → +1 → -1 → 0`，`--ui-font-size` 始终为 `14px`。Windows 原生请求 `430×760` 后实际窗口及 renderer 均为 `480×760`，DPR `1.25`；控件未溢出，设置导航可达。截图和 JSON 位于第二轮 run 的 `sidebar-theme-zoom/` 目录。

`e2e:fixture:check` 无参执行退出 1，只输出用法。检查器源码限定 conversation-session/plugin 的正式或 pending spec，T11 的 settings/UI-shell spec 不属于其支持范围，故此项不适用；没有将其记为通过。

## 文件与自审

- 规范：`docs/ui/default-theme.md`、`docs/ui/workspace-sidebar-footer.md`。
- 实现：`packages/ui/src/WorkspaceSidebarFooter.tsx`、`project-sidebar/index.tsx`、`settingsCodePreview.tsx`、`SettingsPage.tsx`、中英文 locale。
- 单元测试：新增 `sidebarThemeShortcut.test.ts`、`settingsDesktopZoom.test.ts`，扩展 `useTheme.test.ts`。
- 桌面 E2E：新增 `settings/sidebar-theme-zoom.test.ts`，迁移 `settings/settings-ui-polish.test.ts` 与 `ui-shell/general-coding-mode.test.ts` 的旧入口断言；PTY 测试命令修正有截图证据。
- 自审：未新增第二份主题/缩放业务状态 owner；组件沿现有平台 hook 调命令，仍由桌面窗口事实驱动；无跨层直连、主题 token 修改或无关仓库文件变更。相对固定 BASE 的 Agent 源码、shared/services、lock 与构建脚本输入无 diff；首次正式 E2E 已完整重建 Desktop UI，之后同一生产代码复用该产物。补跑的 onPrepare 自行重建 Agent 依赖与 bundle，不将 skip preflight 视作源码指纹证明。

## 未覆盖范围

- 仅 Windows 真机 Electron 实测；macOS、Linux 窗口控件布局与真实 SSH 工作区未实测。Web 隐藏通过定向 UT 验证。
- `settings-ui-polish.test.ts` 仅运行 UP-01，`general-coding-mode.test.ts` 的 MODE-01 与 MODE-02/03 分别在最终轮通过；不宣称前者全文件或首轮 MODE 全文件通过。
- 当前 Node 24.14.0 的最终静态检查和 UT 通过；MODE-02/03 最终补跑实际 Node 24.18.0，需在目标版本需要时补一次 Windows E2E。
