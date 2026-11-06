import { z } from "zod";
import {
  EXTERNAL_ENGINE_RUNTIMES,
  engineConnectionFailureSchema,
  type ExternalSessionEngine,
} from "./contract.js";

// 外部引擎连接配置契约与子进程环境规则（docs/desktop/external-agent-engines-spec.md「连接与认证规则」）。
// 纯函数：Host 的诊断/登录与 CLI 启动 adapter 共用同一份规则，不读写文件、进程或凭据。

export const EXTERNAL_ENGINE_CONNECTION_MODES = ["inherit", "official", "apiKey"] as const;
export const externalEngineConnectionModeSchema = z.enum(EXTERNAL_ENGINE_CONNECTION_MODES);
export type ExternalEngineConnectionMode = z.infer<typeof externalEngineConnectionModeSchema>;

const externalSessionEngineSchema = z.enum(["claude-code", "codex"]);

/** 两家引擎都内置的「沿用 CLI」配置 ID。 */
export const INHERIT_ENGINE_CONNECTION_ID = "inherit";
/** Claude 内置「官方登录」配置 ID：使用用户自己的 Claude 登录，即 1.0.7 行为。 */
export const CLAUDE_OFFICIAL_ENGINE_CONNECTION_ID = "official";
export const EXTERNAL_ENGINE_CONNECTIONS_FILE = "connections.json";
export const CODEX_OFFICIAL_BASE_URL = "https://api.openai.com/v1";
export const ANTHROPIC_OFFICIAL_BASE_URL = "https://api.anthropic.com";
const OFFICIAL_API_HOSTS: Record<ExternalSessionEngine, string> = {
  codex: "api.openai.com",
  "claude-code": "api.anthropic.com",
};
export const ENGINE_CONNECTION_NAME_MAX_LENGTH = 80;
export const ENGINE_CONNECTION_TEST_REPLY_MAX_LENGTH = 120;

export const externalEngineConnectionProfileSchema = z.object({
  id: z.string().regex(/^(?:inherit|[a-zA-Z0-9-]{1,80})$/),
  /** 1.0.7 的连接文件只有 Codex 配置，缺省视为 codex。 */
  engine: externalSessionEngineSchema.default("codex"),
  name: z.string().trim().min(1).max(ENGINE_CONNECTION_NAME_MAX_LENGTH).optional(),
  mode: externalEngineConnectionModeSchema,
  baseUrl: z.string().url().optional(),
  model: z.string().trim().min(1).optional(),
  credentialKey: z.string().optional(),
  hasApiKey: z.boolean().default(false),
  /** 编辑或删除后不再出现在选择器中；已绑定的会话仍可按 ID 解析。 */
  hidden: z.boolean().optional(),
});
export type ExternalEngineConnectionProfile = z.infer<typeof externalEngineConnectionProfileSchema>;

export const externalEngineConnectionsSchema = z.object({
  /** 1.0.7 的 Codex 当前连接；新版本写入时同步为 Codex 的上次使用值，供回退旧版本读取。 */
  activeProfileId: z.string(),
  /** 每个引擎上次使用的配置，新草稿默认选用。 */
  lastUsed: z
    .object({ "claude-code": z.string().optional(), codex: z.string().optional() })
    .optional(),
  profiles: z.array(externalEngineConnectionProfileSchema),
});
export type ExternalEngineConnections = z.infer<typeof externalEngineConnectionsSchema>;

/** 返回 UI 的配置视图：不含凭据键，附内置标记与网关域名。 */
export const externalEngineConnectionViewSchema = externalEngineConnectionProfileSchema
  .omit({ credentialKey: true })
  .extend({
    builtIn: z.boolean().optional(),
    gatewayHost: z.string().max(255).optional(),
  });
export type ExternalEngineConnectionView = z.infer<typeof externalEngineConnectionViewSchema>;
export const externalEngineConnectionsViewSchema = z.object({
  /** 新草稿实际使用的配置：上次使用值，隐藏或缺失时回落内置缺省。 */
  defaults: z.object({ "claude-code": z.string(), codex: z.string() }),
  profiles: z.array(externalEngineConnectionViewSchema),
});
export type ExternalEngineConnectionsView = z.infer<typeof externalEngineConnectionsViewSchema>;

interface ExternalEngineConnectionFields {
  engine: ExternalSessionEngine;
  name?: string;
  mode: ExternalEngineConnectionMode;
  baseUrl?: string;
  model?: string;
  /** 只在新建或更换密钥时传入；编辑时留空沿用旧密钥。 */
  apiKey?: string;
}
/** Host 唯一的连接配置写入命令；编辑生成新 ID，删除只隐藏。 */
export type ExternalEngineConnectionCommand =
  | ({ type: "create" } & ExternalEngineConnectionFields)
  | ({ type: "edit"; profileId: string } & ExternalEngineConnectionFields)
  | { type: "delete"; engine: ExternalSessionEngine; profileId: string }
  | { type: "select"; engine: ExternalSessionEngine; profileId: string };
export interface ExternalEngineConnectionUpdate {
  connections: ExternalEngineConnectionsView;
  /** create / edit 生成的新配置 ID。 */
  profileId?: string;
}

export interface ExternalEngineConnectionTestInput {
  engine: ExternalSessionEngine;
  profileId: string;
  /** 承载测试的本地 workspace；测试本身使用临时 cwd。 */
  workspacePath: string;
}
export const externalEngineConnectionTestResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), latencyMs: z.number().int().min(0) }),
  z.object({
    status: z.literal("unexpectedReply"),
    latencyMs: z.number().int().min(0),
    reply: z.string().max(ENGINE_CONNECTION_TEST_REPLY_MAX_LENGTH),
  }),
  z.object({
    status: z.literal("failed"),
    latencyMs: z.number().int().min(0).optional(),
    failure: engineConnectionFailureSchema,
  }),
  z.object({ status: z.literal("cancelled") }),
]);
export type ExternalEngineConnectionTestResult = z.infer<
  typeof externalEngineConnectionTestResultSchema
>;

/** 内置配置不落盘、不可编辑或删除。 */
export function builtInEngineConnectionProfiles(
  engine: ExternalSessionEngine,
): ExternalEngineConnectionProfile[] {
  const inherit: ExternalEngineConnectionProfile = {
    id: INHERIT_ENGINE_CONNECTION_ID,
    engine,
    mode: "inherit",
    hasApiKey: false,
  };
  return engine === "claude-code"
    ? [
        { id: CLAUDE_OFFICIAL_ENGINE_CONNECTION_ID, engine, mode: "official", hasApiKey: false },
        inherit,
      ]
    : [inherit];
}

/** 新会话无上次使用值、旧原生会话无绑定时的配置：保持 1.0.7 行为。 */
export function defaultEngineConnectionProfileId(engine: ExternalSessionEngine): string {
  return engine === "claude-code"
    ? CLAUDE_OFFICIAL_ENGINE_CONNECTION_ID
    : INHERIT_ENGINE_CONNECTION_ID;
}

export function findEngineConnectionProfile(
  connections: ExternalEngineConnections | undefined,
  engine: ExternalSessionEngine,
  id: string,
): ExternalEngineConnectionProfile | undefined {
  return (
    builtInEngineConnectionProfiles(engine).find((profile) => profile.id === id) ??
    connections?.profiles.find(
      (profile) =>
        profile.engine === engine && profile.id === id && id !== INHERIT_ENGINE_CONNECTION_ID,
    )
  );
}

/** 新草稿缺省配置：上次使用值（Codex 兼容 1.0.7 activeProfileId），隐藏或缺失时回落内置缺省。 */
export function lastUsedEngineConnectionProfileId(
  connections: ExternalEngineConnections | undefined,
  engine: ExternalSessionEngine,
): string {
  const candidate =
    connections?.lastUsed?.[engine] ??
    (engine === "codex" ? connections?.activeProfileId : undefined);
  const profile = candidate
    ? findEngineConnectionProfile(connections, engine, candidate)
    : undefined;
  return profile && !profile.hidden ? profile.id : defaultEngineConnectionProfileId(engine);
}

/** 会话应绑定的配置 ID：显式绑定优先；旧原生会话保持 1.0.7 行为；新会话用上次使用值。 */
export function resolveEngineConnectionProfileId(
  connections: ExternalEngineConnections | undefined,
  input: {
    engine: ExternalSessionEngine;
    connectionProfileId?: string;
    externalSessionId?: string;
  },
): string {
  if (input.connectionProfileId) return input.connectionProfileId;
  if (input.externalSessionId) return defaultEngineConnectionProfileId(input.engine);
  return lastUsedEngineConnectionProfileId(connections, input.engine);
}

/** 管理连接的专用 CODEX_HOME，相对 YCode engines 目录。 */
export function engineConnectionCodexHomeSegments(profileId: string): string[] {
  return ["connections", profileId, "codex-home"];
}

export function engineConnectionCredentialKey(
  engine: ExternalSessionEngine,
  profileId: string,
): string {
  return `external-engine:${engine}:${profileId}`;
}

/** 只提取 http(s) 地址的 host（含非默认端口），不返回路径、查询或账号。 */
export function engineConnectionUrlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/** 未填写或指向官方 API 主机时视为官方地址。 */
export function isOfficialEngineBaseUrl(
  engine: ExternalSessionEngine,
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === OFFICIAL_API_HOSTS[engine];
  } catch {
    return false;
  }
}

/** API Key 配置的自定义网关 host；官方地址与其他方式没有固定网关。 */
export function engineConnectionGatewayHost(
  profile: Pick<ExternalEngineConnectionProfile, "engine" | "mode" | "baseUrl">,
): string | undefined {
  if (profile.mode !== "apiKey" || isOfficialEngineBaseUrl(profile.engine, profile.baseUrl))
    return undefined;
  return engineConnectionUrlHost(profile.baseUrl);
}

const CODEX_MANAGED_STRIPPED_ENV = [
  "DEFAULT_AUTH_REQUEST",
  "CODEX_CONFIG",
  "MODEL_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_HOME",
];
const CLAUDE_API_KEY_STRIPPED_ENV = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * 按连接方式构造 adapter / 官方 CLI 子进程环境。
 * - 所有方式：剔除 APP_SERVER_LOGS（原生帧日志含 Authorization）。
 * - 沿用 CLI：其余变量原样保留，含继承的 ANTHROPIC_* 与 OPENAI_*。
 * - Codex 管理连接：专用 CODEX_HOME，去除网关、密钥与 provider 覆盖；密钥只经 providers/set。
 * - Claude 官方登录：去除描述符登记的三项计费变量（1.0.7 行为）。
 * - Claude API Key：去除全部 ANTHROPIC_* 与云厂商开关，只注入本配置的地址与密钥。
 */
export function buildEngineConnectionEnv(input: {
  env: Record<string, string | undefined>;
  profile: ExternalEngineConnectionProfile;
  /** Codex 管理连接必填的专用 CODEX_HOME。 */
  codexHome?: string;
  /** Claude API Key 连接的密钥；Host 诊断不传。 */
  apiKey?: string;
}): Record<string, string | undefined> {
  const env = { ...input.env };
  const remove = (matches: (upperKey: string) => boolean) => {
    for (const key of Object.keys(env)) if (matches(key.toUpperCase())) delete env[key];
  };
  remove((key) => key === "APP_SERVER_LOGS");
  const { profile } = input;
  if (profile.mode === "inherit") return env;
  if (profile.engine === "codex") {
    if (!input.codexHome) throw new Error("external_engine_connection_invalid");
    remove((key) => CODEX_MANAGED_STRIPPED_ENV.includes(key));
    env.CODEX_HOME = input.codexHome;
    if (profile.model) env.CODEX_CONFIG = JSON.stringify({ model: profile.model });
    return env;
  }
  if (profile.mode === "official") {
    const stripped = EXTERNAL_ENGINE_RUNTIMES["claude-code"].strippedEnvVars;
    remove((key) => stripped.includes(key));
  } else {
    remove((key) => key.startsWith("ANTHROPIC_") || CLAUDE_API_KEY_STRIPPED_ENV.includes(key));
    if (input.apiKey) {
      if (isOfficialEngineBaseUrl("claude-code", profile.baseUrl))
        env.ANTHROPIC_API_KEY = input.apiKey;
      else {
        env.ANTHROPIC_BASE_URL = profile.baseUrl;
        env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
      }
    }
  }
  if (profile.model) {
    remove((key) => key === "ANTHROPIC_MODEL");
    env.ANTHROPIC_MODEL = profile.model;
  }
  return env;
}
