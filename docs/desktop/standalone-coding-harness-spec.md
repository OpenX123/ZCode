# 独立桌面 Coding Harness

状态：2026-10-24 用户确认；实现已落地，macOS arm64 生产安装包隔离启动验收通过；真实 API、外部 SSH 和其他平台验证边界见验证记录。

## 产品边界

保留桌面、CLI、SSH、会话、终端、编辑、Git、Skills、插件、MCP、Subagents、普通定时任务、动态工作流和本地 App Usage。GLM 只作为普通 API Provider，不需要产品账号。

工作区终端可显式启动用户安装的原生 Claude Code，默认传入权限模式 `auto`；原生 TUI 和会话事实由 Claude Code 管理，不恢复已移除的第三方 Agent Provider。见 [Claude Code 原生终端接入](./claude-code-native-terminal-spec.md)。

移除官方账号、套餐、额度、邀请、营销、推广、云分享、反馈上传、遥测、原厂手机云端远控、原厂更新检查、官方 Server MCP 凭证注入和闲时 ticket 调度。不新建替代商业服务。手机远控仅以用户自托管中继 + 端到端加密配对的方式提供，不依赖任何原厂服务，见 [手机远控（自托管中继）](./mobile-remote-spec.md)。

安装架构不匹配时保留本地提示，用户自行安装原生架构构建，不提供原厂下载跳转。

首次启动直接进入桌面。无模型时允许查看历史、管理项目和编辑草稿，发送前打开通用模型配置，不自动选择模型或改变计费来源。

设置侧栏和常规设置不再展示职业／偏好「引导」入口。旧职业引导组件已退出装配，入口仅写入无人读取的 UI 状态；删除这两个入口、回调、对应状态与专属文案，不重新接入旧引导。独立数据迁移继续由现有迁移流程和 `onboardingDialogRequested` 管理。

验收：打开设置并进入常规页，侧栏无「引导」按钮，常规页无「打开引导」项，其他设置仍可操作。桌面回归场景见 `packages/desktop/test/e2e/settings/manual-review/pending/settings-onboarding-removal.test.ts`；该场景不发送模型请求、不执行数据迁移。

无可用模型的横幅只提示配置模型 API，不提示开通套餐或升级。已退役商业错误分类不再驱动本地化、按钮或动作；普通 Provider 错误原文、MCP OAuth 和本地用量文案保留。

## 状态与接口

- Provider Registry 是可执行模型的唯一事实源；随包 Built-in 和 Personal Repository 提供配置，不加载 Account Overlay 或远端配置缓存。
- 例外：外部 Agent 引擎会话（Claude Code / Codex，见 [external-agent-engines-spec](./external-agent-engines-spec.md)）不经过 Provider Registry，可执行性由引擎就绪（adapter 已安装、官方 CLI 已登录）决定，未就绪返回 `engine_not_ready`。其模型调用由用户自己的官方 CLI 发起，属于用户显式配置，与 H07 不冲突；adapter 只在用户点击安装时访问 npm。
- 跨 Environment 的 Provider 配置同步仅由连接上线、Personal 配置和默认选择变更触发；账号设置与官方凭据变化不触发同步。Source 仅依赖 Personal Repository 和对应文件，旧信封的账号字段只保留校验兼容，不读取或应用旧凭据。触发器只存在于运行时代际，不是持久化历史。
- 本地 App Usage 错误只呈现本地读取失败和原始错误，不使用套餐、账号或 API Key 错误分类，也不跳转模型配置。
- CLI 不装配执行遥测 facade、port、因果传播、span writer 或空实现；turn、step、工具、命令、compact、后台标题和 Memory 直接执行既有业务生命周期。模型请求归因、ModelStatus、本地日志、TTFT、用量与耗时、compact timeline 和 AbortSignal 继续保留，不能因删除观测包装改变取消或错误语义。
- 用户操作直接执行原有命令与回调，不保留遥测采样、追踪队列、导出或事件发送旁路。桌面稳定客户端 ID 仅服务本地会话流关联，沿用旧值和文件名，不参与请求来源追踪。
- 用户设置由既有 SettingService 写入；动态工作流保留明确设置，缺省 onDemand；桌面与 SSH 的生效优先级为用户设置 > 内置 onDemand 默认，不读取发行档位、环境灰度或远端配置。独立 CLI 的通用解析器可显式传入本地环境覆盖。兼容接口中的 remote 输入但不访问其内容，快照来源仅为 override/default。
- CLI 拥有会话正文和执行事实，Host 拥有组织态和调度。workspaceIdentity 用于身份，workspacePath 用于文件操作。
- Source 自动重连保留 Host 的 session/generation 唯一所有权；Main 同步换代 descriptor/转发 route 与 Provisioning 登记，复用 `attachRendererPort` 恢复已有 Desktop。Renderer 注册 services 并以当前窗口、sessionId、attachmentId ACK 后，Main 才提升 candidate、拆旧 attachment 并发送 `RemoteSessionReconnected`；迟到 ACK、连续重连、关闭和 Host 退出不得提交旧代。重连配置重下发与 Desktop 恢复并行，首次连接的 Provisioning 成功屏障保持不变；失败明确清理对应 candidate 并告警，不影响更新的 route。详见 [Provider Provisioning 的 owner/ACK 时序](../remote/provider-provisioning.md#自动触发)。
- `mobileOnly` scope 重连不自动创建 Desktop attachment，显式桌面 adoption 才沿既有 ACK 提交；保留合法 scope join、取消和 target/owner 隔离，不恢复旧官方手机 `replaceRemoteSession` 桥。自托管手机一期仍只接本地窗口，不扩展跨 SSH。
- 删除官方专用 Service、RPC/IPC、preload、WebView、轮询和构建装配；共享安全与执行接口按真实引用保留。
- 内置目录和运行时随本仓库构建发布。Built-in Source 仅读取明确的随包文件并监听该本地文件，不读写旧 Active/LKG、Endpoint 缓存或刷新控制文件，不提供远端下载、应用 Release、周期检查或刷新接口。Host 向 Agent 传递同一随包路径；Personal 的锁、备份、轮询和原子更新保持原有所有者。默认插件市场使用自托管地址 `https://skill.artai.top/marketplace.json`，沿用 `zcode-plugins-official` 身份与既有安装记录；仅在该身份尚未登记时补种，不覆盖用户已有来源。本地插件与用户显式添加的来源保留，插件分发不依赖原厂账号。
- Agent 的默认、bootstrap 与 Turbo 源码构建都先清理目标 workspace 包的 dist，再按现有依赖顺序重建；防止已删除源文件的旧 JS 被 Server 整包暂存带入安装包。只清理构建输出，不触及用户数据。
- 桌面资源准备先完成 Source Server 构建，最后由桌面 Agent 准备步骤统一重建 Agent、插件及原生依赖闭包；后续 Server 构建不得清空已经完成的桌面资源。Koffi 仅服务 Windows Agent 的 MCP Job Object，放在 Agent 可解析的 `glm/node_modules` 并单独映射进安装包；当前 CUA SDK 不要求或校验过时的 Koffi 副本，macOS/Linux 不携带该 Windows 依赖。
- 正式安装包只携带 Source Server descriptor，四平台归档作为独立 Release 附件发布；descriptor 中的绝对 URL 固定本次不可变构建、size 与 SHA-256，不能运行时查询 latest。同一版本不同构建按 SHA 隔离。桌面安装器直接审计实际压缩体积，不再增加离线资源额度；四平台独立资源仍逐个校验 size/SHA 和完整性。
- 运行时不捕获或转注入旧 Agent 遥测变量；环境清洗仍拒绝 OTEL、旧遥测身份及其 tool passthrough 恢复，CUA broker 定向捕获和用户网络配置保持原有边界。
- 默认启动、空闲及普通 coding 不访问原厂业务服务；用户自配模型 API、MCP、插件及显式命令可以联网。按用途和路径验收，不封禁整个模型供应商域名。

```mermaid
flowchart TD
  A[本地设置与随包资源] --> B[Host 启动]
  B --> C[恢复工作区和只读历史]
  B --> D[Built-in 加 Personal Provider Registry]
  C --> E[用户发送]
  D --> F{选定模型可执行?}
  E --> F
  F -->|否| G[保留草稿并打开通用配置]
  F -->|是| H[CLI CommandInbox 接纳]
  H --> I[用户自配模型与工具执行]
  I --> J[CLI 持久化并发布事件]
  J --> K[Host 镜像与桌面展示]
```

## 数据兼容

不删除或重建数据库、旧列、正文、附件、项目或分组。旧官方凭据留在磁盘但不读取；普通模型、SSH 和 MCP 凭据不变。旧套餐模型仍可展示历史，执行时要求手动换模型，不自动回退。普通自动化保存了失效模型时阻止执行。旧闲时记录不再调度，已生成的会话保留为历史。必要配置写入复用 Repository 的锁、备份和原子更新。

旧账号设置仅在磁盘读取边界解码并保留回滚字段；缺少组织信息的旧 Team 连接保持原样。设置服务不查询官方账号、不补齐组织，也不自动修复远端连接。

已发布 `config.json` 的普通按量 API Key 首次升级仍由 Personal Repository 的单向导入器负责：`builtin:bigmodel` 和 `builtin:zai` 分别保留稳定 Provider ID `bigmodel-api`、`zai-api`，关联当前随包模板 `bigmodel-standard-api`、`zai-standard-api`。Provider 身份与模板身份是两个字段，不能随模板重命名改写用户选择；只迁入非空用户 Key，不冻结旧模型名单、旧端点、官方账号或套餐配置。旧文件不变，完成首次导入后以当前 Personal 文件为准，后续用户删除或编辑不会再次导入。导入后的实际解析须使用当前随包模板，保留普通模型可执行性、用户自定义启停、原子写入与备份语义。

搜图等依赖官方 Server MCP 的插件不默认启用。旧插件中的官方鉴权声明继续拒绝解析，不匿名降级请求。

插件目录不再声明或透传 `requiresPaidPlan`，卡片和详情不展示套餐徽标或套餐使用建议。旧目录携带该字段时忽略它，插件安装、配置、启停及普通 MCP OAuth 保持原有链路，不改写会话历史。

SSH / WSL / Docker 资源由 Host 现有 resolver 唯一管理。正式版优先读取随包本仓库 descriptor；仍带归档的源码离线构建继续校验并使用本地归档。仅有 descriptor 时，默认按探测到的目标下载一份并上传；SSH 显式选择远端下载时只返回该 descriptor 的固定 URL 与校验信息。普通本地启动和编码不触发远程资源下载。显式镜像沿用现有网络注入，失败不得回退旧缓存 descriptor 或原厂地址。随包 descriptor 缺失且无显式镜像时必须报错。

Host 下载缓存路径为 `<remoteCacheDir>/source-server/<version>/<target>/<sha256>/<fileName>`，每次复用必须验证 size/SHA；可信随包 descriptor 允许有效缓存完全离线复用。离线首次部署可预先导入独立 Release 的归档到此路径，导入过程同样校验 size/SHA。缓存文件不是版本/地址的权威，不能从旧缓存 descriptor 推导下载地址。不同根目录、目标和 SHA 不共用缓存或锁。

同一缓存内容的跨 Host/进程请求由文件锁串行化，下载先写唯一临时文件，校验后原子提交；等待者校验缓存后复用。失败、取消和超时清理本次临时文件与持有锁，不删除其他 SHA 的资源。已退出进程的锁允许安全回收；若回收进程自身退出留下标记，确认后立即返回可精确定位本机锁目录的恢复提示，不争抢删除回收标记。锁等待和网络请求均有时限。连接取消的信号可传入 resolver，预览元数据不得下载归档。开发态 `development-content-addressed` 仍强制消费本轮本地 descriptor/archive，缺失或损坏不得回退正式版下载。

### 中断回收的本机恢复出口

中断回收使用公开错误码 `source-server-cache-lock-interrupted`、`retryable:false` 和不含路径或发行标识的固定安全正文。日志、普通错误详情及复制内容仍按原规则脱敏；已知秘密即使恰好等于公开 target 或 SHA 也不豁免。恢复定位不解析正文，而由本机 Host resolver 从已校验 descriptor 生成严格的 `cacheRecovery`：`{kind:"source-server-cache-lock",version,target,sha256}`。target 复用既有四值 schema，sha256 为小写64位hex，version 必须是无路径片段的安全版本并在动作入口等于当前构建版本；拒绝额外字段。绝对 root、路径、URL、凭据、PID、owner token、profile 或任意文件名不属于该结构。

resolver 是可信恢复事实的唯一生产者，用本地专用 Error 的类型/私有字段证明来源。连接管理器仅将该实际失败 owner 的 locator 投影到当前失败 snapshot；连接失败 reply 和管理 RPC 的现有 `Error.data` 显式序列化同一严格字段，经过 Main/Renderer 的白名单重建及 flow/项目失败交接抵达现有 UI。不增加通用错误 metadata 透传、恢复数据库或第二个锁 owner。普通远端异常即使伪造相同 code、`cacheRecovery` 或 `data.cacheRecovery`，也不能被认领为本机恢复事实，相关源服务器出口须剔除伪造的保留字段。

locator 仅跟随当前失败/epoch；新连接、更新、成功、断开、删除和 resetFeedback 清除，不持久化或继承为另一 profile/新 flight 的锁事实。普通文本/log中不展示、复制或整包记录 locator，手机/Web 不提供本机打开动作。

只有本机 Desktop 实现可选平台能力 `openSourceServerCacheRecoveryDirectory(recovery)`。Main 严格校验后，使用与 Host 相同的 `resolveRemoteAssetDirs({}, hostProcessLocalEnv)` 配置根重建当前版本、target、SHA父目录及固定归档锁名；以 native path、异步 realpath/lstat 确认严格后代及真实层级，拒绝 root 下 symlink/junction 绕出、非法版本、缺失/已消失锁或非普通目录。仅打开精确 SHA父目录，不回退版本根，不接收任意路径，不创建、下载或删除文件，不返回真实路径。复用既有跨平台文件管理器 helper；该动作的日志仅记录固定安全事件，原生失败的正文也须脱敏。

首次连接/安装失败、向导升级失败、设置设备更新失败（包括仍在线）都在现有错误面板/详情中提供精确定位与原显式重试入口。只有 code、严格 locator 与本机平台能力三者齐备时，才显示可用定位动作；缺少能力时说明需在所属 Desktop 处理，定位失败不能让用户猜测目录。打开结果只影响局部按钮状态，迟到结果不得重新打开旧面板或覆盖新错误。

操作步骤固定显示且可复制，不含 locator 或本机路径：先定位并保留文件管理器窗口和离线说明；保存工作，通过 Windows/Linux 托盘“退出”或 macOS Cmd+Q/应用菜单完整退出所有使用该缓存的实例（Linux无托盘时使用应用正常退出路径）；退出确认取消、关窗或隐藏不算退出；等待现有 Host 清理完成后，手动仅删除已定位目录内目标 `.tar.gz.lock` 文件夹，保留归档、SHA父目录和其他SHA，重启后显式重试。产品不自动删除或强杀其他实例。

```mermaid
sequenceDiagram
  participant R as Host resolver（锁owner）
  participant S as 连接管理器（失败状态owner）
  participant B as 现有IPC与管理RPC
  participant F as flow或设备错误投影
  participant M as Main（本机路径与原生打开）
  participant U as 用户与文件管理器
  R->>R: 从可信descriptor确认中断回收并生成私有locator
  R-->>S: 专用Error、安全正文、retryable:false
  S->>S: 核验来源，记录当前owner失败投影
  S-->>B: 显式严格cacheRecovery，日志仍脱敏
  B-->>F: 现有epoch下的失败字段
  F->>M: 用户点击精确定位平台动作
  M->>M: 同配置root、版本、canonical层级与普通锁目录校验
  M->>U: 打开唯一SHA父目录，不回传路径
  F-->>U: 可复制的固定离线步骤
  U->>M: 正常完整退出，保留文件管理器窗口
  M->>R: 现有异步Host清理屏障
  U->>U: 完全退出后手动仅清理目标lock
  U->>M: 重启并通过原入口显式重试
```

验收必须包含两种残留 marker 的真实文件系统、秘密与SHA/target碰撞、多SHA精确定位、伪造字段拒绝、真实管理RPC序列化、实际Main IPC handler、三条UI入口及旧结果抑制。桌面E2E用专门隔离lock fixture；仅在完整旧进程树归零后的 `afterElectronProcessExit` 清理夹具自己的精确锁，再重启验证恢复，禁止裸reload/rm或以固定等待推测无writer。至少一次系统层确认实际文件管理器打开目标目录，正常退出与helper强制清理结果分别记录；不把Windows实测外推为macOS/Linux实机通过。

回收者以独占创建的 `.reaping` 标记取得本次失效锁的回收权。标记写入后先关闭其文件句柄，再校验旧 owner/token 并原子移走旧锁目录；保留标记本身直到旧目录清理完成，不能在关闭句柄时删除标记。这样兼容 Windows 对打开文件所在目录的重命名限制，同时让其他等待者持续看到唯一回收者。退出、错误与取消只清理本次退休目录，不删除后来者重新创建的同名锁。两个并发请求竞争同一已退出 owner 的锁时，应安全完成回收、只下载一次，并只留下校验通过的当前归档。

```mermaid
sequenceDiagram
  participant R as 回收者
  participant L as 失效锁目录
  participant W as 并发等待者
  R->>L: 独占创建.reaping并写入回收者身份
  R->>R: 关闭标记文件句柄（标记仍保留）
  W->>L: 看到现存标记，保持等待
  R->>L: 复核旧owner/token与进程退出
  R->>L: 原子重命名为本次退休目录
  R->>L: 仅清理本次退休目录
  W->>L: 重新竞争新的缓存锁
```

```mermaid
sequenceDiagram
    participant C as 连接管理器
    participant H as Host resolver
    participant D as 随包 descriptor
    participant K as 内容寻址缓存
    participant R as 固定 Release
    C->>H: 探测目标并请求资源
    H->>D: 读取本次 size/SHA/URL
    H->>K: 校验对应 SHA 的缓存
    alt 缓存有效
        K-->>H: 返回已验证归档
    else 缓存缺失或损坏
        H->>K: 独占文件锁
        H->>R: 按目标下载唯一临时文件
        R-->>H: 归档字节
        H->>K: 校验后原子提交并释放锁
    end
    H-->>C: 归档路径或远端下载元数据
```

生产与测试随包模型目录都不声明账号套餐成员或产品网关能力；普通 GLM API 模板保留。旧 Agent 二进制下载脚本删除，开发和打包统一使用源码构建入口。

新 MCP 工具结果 display 不接受官方套餐不可用标记；旧结果在 CLI 读取边界仅从内存投影剥离 `unavailable`，保留服务器、工具、描述和插件 UI，不改写持久化历史，也不恢复商业错误解析或提示。

## 已接受验收场景

| ID  | 前置与操作                                       | 断言                                                      | 证据                 |
| --- | ------------------------------------------------ | --------------------------------------------------------- | -------------------- |
| H01 | 空白隔离目录、断网启动桌面                       | 无登录页或账号等待；能浏览项目与历史；无模型可保留草稿    | UI、启动日志         |
| H02 | 配置普通 Provider 和 GLM API，保存后重启         | 使用用户凭据，配置持久化，不获取官方账号凭据              | UI、请求、配置文件   |
| H03 | 发送 coding 请求、工具调用、停止、续聊与 compact | 流式输出和权限正常；文件/终端/Subagent 可用               | UI、协议、文件       |
| H04 | 加载旧历史及套餐模型选择                         | 历史完整；执行前手动换模型；不改写旧选择                  | UI、数据库对比、请求 |
| H05 | 加载本地 Skills、插件、MCP、工作流与定时任务     | 无官方账号依赖；动态工作流默认 onDemand；失效模型阻止执行 | UI、工具协议         |
| H06 | 本地源码产物部署到 SSH、断开后重连               | 远端可执行；身份、目录、会话隔离不变                      | 真实 SSH 或隔离集成  |
| H07 | 观察启动、空闲、配置和普通 coding                | 无官方业务服务请求；用户配置模型调用不被阻断              | 网络和服务调用记录   |

## 官方协议与交互退出

- 新 sendText、editUserQuery 和 sendQueuedNow 请求拒绝 highspeedMeta；setHighspeedMetrics 不再属于命令协议。删除高速卡材料暂存、凭据注入、隐式 selectionFallback、指标写入和 Start Plan 专属重试。普通流恢复、工具结算、预算和取消沿用现有链路。
- 旧套餐选择在排队提升、编辑/retry 的历史截断前拒绝；保留原输入和选模，不切换 Provider 或计费来源。旧高速卡事件、metadata、feedback 仅供历史读取，不改写文件。
- 删除点赞/点踩上传操作、乐观状态及组件回调，保留复制、派生与时间。CronCreate 继续覆盖创建入库、派生、详情和保存。
- 常规设置不再展示或读写预览版更新与自动下载安装开关。旧 schema 字段保留兼容；硬件加速、任务通知和声音仍通过原设置所有者保存。
- 远程握手遇到桌面版本不兼容时，提示手动安装本仓库兼容构建，不触发官方检查或下载。Server 更新仍走本仓库源码产物与现有安装流程。
- 旧 `.zcode-share/*/shared-conversation.json` 通过 `IZCodeSessionService.getImportedConversation` 在工作区本地只读解析，不请求官网或恢复云分享服务。

## 工作流设置与目录同步

设置文件是用户选择的唯一来源，Host 裁决并串行同步给各 workspace CLI。Renderer 在 Host 同步完成后的本地可用性投影改变时，复用 readWorkspacePresentation 重新水合已有目录，不自行增删命令。每个 workspace identity 串行水合，同一策略共享在途请求；旧策略的迟到结果不得覆盖新策略。切换模式不修改活跃会话工具面、模型或持久化会话。

```mermaid
sequenceDiagram
  participant U as 设置界面
  participant S as SettingService
  participant H as Host
  participant C as CLI
  participant R as Renderer 目录投影
  U->>S: 保存用户模式
  S-->>H: Root 同步变更信号
  H->>C: 更新工作区策略
  C-->>H: 策略已应用
  H-->>R: 重读本地生效模式
  R->>C: 通过既有 Service 读取 workspace presentation
  C-->>R: 当前模式的命令目录
  R->>R: 仅发布仍匹配当前策略的结果
```

桌面 E2E 必须等待同一工作区 goal 正向项就绪，以及 workflow 项与本地模式一致，再断言入口显隐；不能把磁盘已写入等同目录已刷新。从设置页进入自动化时先关闭设置页并等待设置消失；返回后若自动化内容已显示则复用当前页，否则点击可见侧栏入口。设置返回目标可以是自动化页，不要求 coding composer 就绪；Host 策略与命令目录屏障保持不变。

## 验证与交付

实际命令、产物、先红后绿回归与证据边界见 [验证记录](./standalone-coding-harness-validation.md)。使用隔离目录，不迁移日常用户数据；不提交、推送或发布。

删除功能的专属测试随实现退役；通用 Provider、MCP OAuth、权限、取消、compact、排队、fork、耗时及历史读取断言迁到保留场景。共享 E2E helper 等待匿名工作区，不播种官方 OAuth/JWT；保留普通 API、MCP OAuth 与 SSH 测试凭据。新桌面场景保持 manual-review/pending，不自动转正或准入 CI。

回放不等同真实模型 API 验收；本机回环 SSH 不等同外部 Linux 或桌面远程身份全链路；macOS 构建不等同 Windows/Linux 实机验收。网络按服务用途与路径检查，普通 GLM API 与用户显式联网能力继续保留。

## GitHub 自托管发行更新

YCode 1.0.0 起恢复本仓库 GitHub Release 的版本提示与用户触发的安装器下载。该能力由 Main 管理，使用固定本仓库清单、当前架构资源和 size/SHA 校验，不接原厂账号、更新服务、灰度渠道或强制升级。应用不自动退出，也不静默替换未签名安装包；具体合同见 [GitHub 桌面更新](./github-desktop-update-spec.md)。旧 3.16.2 用户须先手工安装一次 1.0.0。
