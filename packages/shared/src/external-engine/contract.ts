import { z } from "zod";

// 会话引擎：创建时选定、之后不可变。zcode = 现有 ZCode Agent；其余为经 ACP adapter
// 驱动的官方 CLI（见 docs/desktop/external-agent-engines-spec.md）。
export const SESSION_ENGINES = ["zcode", "claude-code", "codex"] as const;
export const sessionEngineSchema = z.enum(SESSION_ENGINES);
export type SessionEngine = z.infer<typeof sessionEngineSchema>;
export const DEFAULT_SESSION_ENGINE: SessionEngine = "zcode";

export function resolveSessionEngine(
  config: { engine?: SessionEngine } | null | undefined,
): SessionEngine {
  return config?.engine ?? DEFAULT_SESSION_ENGINE;
}

// 引擎经 ACP session/new 返回的可选配置项（mode / model / effort 等），由引擎决定值域；
// YCode 只投影与回传 value，不解释其语义。
export const engineConfigOptionValueSchema = z.object({
  value: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
});
export type EngineConfigOptionValue = z.infer<typeof engineConfigOptionValueSchema>;

export const engineConfigOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  currentValue: z.string(),
  options: z.array(engineConfigOptionValueSchema),
});
export type EngineConfigOption = z.infer<typeof engineConfigOptionSchema>;

export const engineConfigStateSchema = z.enum(["connecting", "ready", "error"]);
export type EngineConfigState = z.infer<typeof engineConfigStateSchema>;

/** 安全诊断只携带固定分类与协议标识，不传播供应商原文。 */
export const engineConnectionFailureSchema = z.object({
  code: z.enum([
    "not_ready",
    "authentication",
    "session_not_found",
    "unsupported",
    "configuration",
    "timeout",
    "transport",
    "request",
    "protocol",
  ]),
  method: z
    .enum([
      "initialize",
      "session/new",
      "session/resume",
      "session/load",
      "session/set_config_option",
      "session/prompt",
    ])
    .optional(),
  rpcCode: z.number().int().optional(),
});
export type EngineConnectionFailure = z.infer<typeof engineConnectionFailureSchema>;

export const engineCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input: z.object({ hint: z.string() }).optional(),
});
export type EngineCommand = z.infer<typeof engineCommandSchema>;

// 外部 Agent 引擎（Claude Code / Codex）运行时描述与就绪状态契约。
// 规则见 docs/desktop/external-agent-engines-spec.md：只驱动官方 CLI 与官方 ACP adapter，
// YCode 不读写凭据、不实现登录；adapter 由用户显式安装到 YCode 管理目录并锁定版本。

export type ExternalSessionEngine = Exclude<SessionEngine, "zcode">;

export const ZCODE_AGENT_ENGINE_NOT_READY_CODE = "ZCODE_AGENT_ENGINE_NOT_READY" as const;
export const ZCODE_AGENT_ENGINE_NOT_READY_REASON = "engine_not_ready" as const;

export interface ExternalEngineRuntimeDescriptor {
  engine: ExternalSessionEngine;
  /** 官方 ACP adapter 的 npm 包名与锁定版本。 */
  adapterPackage: string;
  adapterVersion: string;
  /** adapter 包内的可执行入口（相对包根），由 Electron 自带 Node 运行。 */
  adapterEntry: string;
  adapterNodeEngine: string;
  /** 用户 PATH 中的官方 CLI 名，以及 adapter 识别的"官方可执行文件"环境变量。 */
  officialCliCommand: string;
  officialExecutableEnvVar: string;
  /** adapter 安装树内的官方 CLI JS 入口；PATH 缺失时由 Node 执行。 */
  bundledOfficialCliEntry: string;
  /** 官方 CLI 登录状态命令；只读调用，不触碰凭据文件。 */
  authStatusArgs: readonly string[];
  /** 引导用户在终端执行的官方登录命令。 */
  loginCommand: readonly string[];
  /** 启动 adapter 前从继承环境中剔除的变量（避免改变计费来源）。 */
  strippedEnvVars: readonly string[];
}

export const EXTERNAL_ENGINE_RUNTIMES: Readonly<
  Record<ExternalSessionEngine, ExternalEngineRuntimeDescriptor>
> = {
  "claude-code": {
    engine: "claude-code",
    adapterPackage: "@agentclientprotocol/claude-agent-acp",
    adapterVersion: "0.95.0",
    adapterEntry: "dist/index.js",
    adapterNodeEngine: ">=22.0.0",
    officialCliCommand: "claude",
    officialExecutableEnvVar: "CLAUDE_CODE_EXECUTABLE",
    bundledOfficialCliEntry: "node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
    authStatusArgs: ["auth", "status"],
    loginCommand: ["claude", "auth", "login"],
    strippedEnvVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  },
  codex: {
    engine: "codex",
    adapterPackage: "@agentclientprotocol/codex-acp",
    adapterVersion: "2.2.2",
    adapterEntry: "dist/index.js",
    adapterNodeEngine: ">=20.3.0",
    officialCliCommand: "codex",
    officialExecutableEnvVar: "CODEX_PATH",
    bundledOfficialCliEntry: "node_modules/@openai/codex/bin/codex.js",
    authStatusArgs: ["login", "status"],
    loginCommand: ["codex", "login"],
    // Codex 完全沿用用户 ~/.codex/config.toml 的 provider 设置，不改写其环境。
    strippedEnvVars: [],
  },
};

export function isExternalSessionEngine(
  engine: SessionEngine | null | undefined,
): engine is ExternalSessionEngine {
  return engine === "claude-code" || engine === "codex";
}

export const externalEngineAuthStateSchema = z.enum(["loggedIn", "loggedOut", "unknown"]);
export type ExternalEngineAuthState = z.infer<typeof externalEngineAuthStateSchema>;

export const externalEngineStatusSchema = z.object({
  engine: z.enum(["claude-code", "codex"]),
  adapter: z.object({
    installed: z.boolean(),
    version: z.string().optional(),
    /** managed = YCode 管理目录；path = 用户 PATH 中已有的 adapter。 */
    source: z.enum(["managed", "path"]).optional(),
  }),
  officialCli: z.object({
    found: z.boolean(),
    version: z.string().optional(),
    path: z.string().optional(),
  }),
  auth: z.object({
    state: externalEngineAuthStateSchema,
    /** 官方 CLI 报告的身份类别（订阅 / API Key / 网关），不含账号或密钥。 */
    label: z.string().optional(),
  }),
  /** adapter 已安装且官方 CLI 登录可用时为 true；是外部引擎会话的执行门禁。 */
  ready: z.boolean(),
  error: z.string().optional(),
});
export type ExternalEngineStatus = z.infer<typeof externalEngineStatusSchema>;

// ── 安装布局：Host 安装方与 CLI 启动方共用，保证"装在哪"与"从哪启动"一致 ──

/** Host 启动 CLI 时注入：YCode 管理的 adapter 安装根目录（位于 YCode 数据目录下）。 */
export const EXTERNAL_ENGINES_DIR_ENV = "ZCODE_EXTERNAL_ENGINES_DIR" as const;

/** app-server 数据目录隔离不应改变官方 CLI 的登录目录，仅外部 adapter 恢复此 HOME。 */
export const EXTERNAL_ENGINE_USER_HOME_ENV = "ZCODE_EXTERNAL_ENGINE_USER_HOME" as const;

/** 某引擎锁定版本的安装目录，相对 EXTERNAL_ENGINES_DIR_ENV：`<engine>@<adapterVersion>`。 */
export function managedAdapterInstallDirName(runtime: ExternalEngineRuntimeDescriptor): string {
  return `${runtime.engine}@${runtime.adapterVersion}`;
}

/** adapter 入口相对安装目录的路径段（`npm install --prefix <installDir>` 的产物布局）。 */
export function managedAdapterEntrySegments(runtime: ExternalEngineRuntimeDescriptor): string[] {
  return ["node_modules", ...runtime.adapterPackage.split("/"), ...runtime.adapterEntry.split("/")];
}
