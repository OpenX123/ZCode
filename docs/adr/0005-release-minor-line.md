# 正式版本按 1.<minor> 发版线递增

- 状态：Accepted
- 日期：2026-11-07
- 关联规格：`docs/desktop/github-release-spec.md`、`docs/desktop/github-desktop-update-ui-spec.md`、`docs/desktop/ycode-1.1-plan.md`

## Context

1.0.0 起正式版本只允许 `1.0.<patch>`：发版脚本、Release 资源地址与测试都把 `v1.1.0` 当作无关序列忽略。1.1 引入性能架构与多智能体展示，需要一个能对外区分的次版本，同时保留"由 CI 分配、不可覆盖、不得回退"的发布约束。

## Decision

- 发版线取自根 `package.json` 的 `1.<minor>`；主版本固定为 1。
- main 的手动发版在当前发版线上取最大 patch 加一；新线没有正式标签时从 `1.<minor>.0` 起。
- 远端已有更高发版线的正式标签时拒绝分配，避免发布更低的版本号。
- push、PR 与非 main 运行仍直接使用 `package.json` 版本构建临时 artifact，不分配版本也不创建标签。
- Release 资源地址接受 `v1.<minor>.<patch>` 与 `build-<run>-<attempt>`；桌面更新器沿用通用三段版本比较，无需改动。

## Consequences

进入新发版线只需修改 `package.json` 的次版本。1.0 线的既有行为与测试保持不变；回退到旧发版线必须显式处理已发布的更高版本，不能由脚本静默完成。
