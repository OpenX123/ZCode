# Built-in Provider 配置双环境打包

模板与模型的日常维护见[维护入口](./builtin-provider-maintenance/README.md)；本文继续维护构建与环境转换合同。

## 所有权与边界

构建工具单独拥有配置选择职责，读取现有 `ZCODE_ENV=test|production`。
显式环境变量优先；未设置时读取仓库现有 .env 环境文件，再默认 test。
`NODE_ENV` 只影响读取哪组 .env 文件，不直接决定产品环境。非法非空 ZCODE_ENV 报错。

| 产品环境   | 仓库源文件                              |
| ---------- | --------------------------------------- |
| production | config/provider/zcode-builtin.json      |
| test       | config/provider/zcode-builtin.test.json |

两份都是完整 Release。生产文件是唯一编辑源，测试文件由
`pnpm provider:config:sync-test` 生成并提交，revision 跟随生产文件。
`pnpm provider:config:check-test` 只检查生成结果是否过期，不写文件；纳入单测。
不更改 Release Schema、个人 Overlay、Registry 或账号／模型选择。

## 测试配置生成与运行时边界

测试配置继续由生产源生成并复用完整 Release 校验；普通 API 模板与用户地址不通过官方账号或套餐重写。生成与构建仅处理仓库本地文件，不联网更新目录，也不迁移用户数据。

运行时只采用构建选择的随包文件。旧 Endpoint、Active/LKG 下载缓存和远端刷新控制文件均不参与读取；Host 与 Agent 共用同一随包路径。Personal 覆盖保持原有所有者和持久化机制。

```text
ZCODE_ENV + 对应完整 JSON
             |
             v
共同构建入口：选文件、完整 Release 解码校验
             |
       +-----+--------------------+
       |                          |
       v                          v
Desktop / CLI / SEA 资源     HTTP / Remote / Server CLI 嵌入常量
       |                          |
       +------------+-------------+
                    v
          原有 Built-in Source / Registry
```

Desktop 资源仍为 `resources/config/provider/zcode-builtin.json`；CLI 为
`dist/provider/zcode-builtin.json`；SEA key 仍为 `zcode-provider/zcode-builtin.json`。
Server 保持原有 JSON 编译常量。开发态 Desktop 根据同一个编译环境定位仓库源文件。
显式配置路径注入优先级不变。

读取／解析失败直接终止构建，禁止跨环境 fallback。复用现有 Release 解码器，
不维护第二份 Schema。构建工具只做本地文件读取，不联网下载配置。

跨平台加载 Release 解码器时，必须将文件系统路径转换为 `file:` URL 后交给
`tsImport`，避免 Windows 盘符被 ESM loader 识别为协议。两种环境共用这一入口，
不改变配置选择、校验和禁止跨环境 fallback 的策略。

## 缓存与时序

- 普通 CLI、Desktop、Server 构建仍按原流程执行，不新增缓存层。
- bootstrap 每次重新构建 Agent JS，并由同次 CLI 构建验证和刷新旁边的配置资源，避免 Source Server archive 带入旧 Agent。
- Turbo 的 CLI build 与 build:desktop-agent 包含 ZCODE_ENV、相关 .env、两份配置及公共构建工具。
- Desktop E2E 构建指纹包含公共工具与配置输入；已有环境指纹继续复用。
- 远程 Server 已将配置嵌入 JS；现有 source hash / artifact hash 自然使配置变化触发重新打包。
- 不通过覆写仓库源文件选择环境；不同环境并行构建须使用各自 worktree／输出目录，
  不新增对同一个 dist 的并发写入保证。

配置只随仓库构建发布；运行时不下载官方配置、不按 Endpoint 选择缓存。普通会话执行与 SSH 身份边界不变。

## 验证

用内容不同的临时 Release 区分环境，覆盖缺失／坏 JSON／坏 Schema、环境优先级、
已有 JS 时重新构建并刷新配置、同环境内容更新、SEA 资源及最终嵌入产物。真实两份配置分别解码。
不以“当前两份相同所以测试通过”代替环境选择断言，不要求真实模型请求。

公共构建入口测试与测试环境配置同步测试分文件维护：`builtin-provider-build.test.ts`
只运行公共构建契约；`builtin-provider-test-config-sync.test.ts` 运行内部同步脚本的 Node 测试。
后者与同步脚本及其脚本测试一起按文件排除，公共构建测试在开源导出时原样保留，
不通过补丁删除参数化用例，也不以缺文件时跳过代替闭源侧验证。
