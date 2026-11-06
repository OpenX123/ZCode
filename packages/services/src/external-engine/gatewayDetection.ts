import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  engineConnectionUrlHost,
  isOfficialEngineBaseUrl,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";

// 状态显示只需要网关域名：配置文件在内存中解析后只取 base_url 的 host，
// 不记录、不返回文件内容，不读取 auth.json / .credentials.json 等凭据文件。

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  const value = key ? env[key]?.trim() : undefined;
  return value || undefined;
}

function configDirectory(env: NodeJS.ProcessEnv, override: string, fallback: string): string {
  const configured = envValue(env, override);
  if (configured && isAbsolute(configured)) return configured;
  return join(envValue(env, "HOME") ?? envValue(env, "USERPROFILE") ?? homedir(), fallback);
}

function gatewayHost(engine: ExternalSessionEngine, url: unknown): string | undefined {
  return typeof url === "string" && !isOfficialEngineBaseUrl(engine, url)
    ? engineConnectionUrlHost(url)
    : undefined;
}

/** Codex 沿用 CLI：当前 profile 或顶层 model_provider 对应的 base_url；内置 openai 看 OPENAI_BASE_URL。 */
export async function detectCodexGatewayHost(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let config: Record<string, unknown> = {};
  try {
    config = record(
      parseToml(
        await readFile(join(configDirectory(env, "CODEX_HOME", ".codex"), "config.toml"), "utf8"),
      ),
    );
  } catch {
    // 没有配置文件或无法解析时按无网关处理；不能把解析失败当成登录状态。
  }
  const activeProfile =
    typeof config.profile === "string" ? record(record(config.profiles)[config.profile]) : {};
  const providerId =
    typeof activeProfile.model_provider === "string"
      ? activeProfile.model_provider
      : typeof config.model_provider === "string"
        ? config.model_provider
        : "openai";
  const provider = record(record(config.model_providers)[providerId]);
  if (typeof provider.base_url === "string") return gatewayHost("codex", provider.base_url);
  if (providerId !== "openai") return undefined;
  return gatewayHost("codex", config.openai_base_url ?? envValue(env, "OPENAI_BASE_URL"));
}

/**
 * Claude 在子进程环境之后应用 settings.json 的 env，只读其中的 ANTHROPIC_BASE_URL；
 * 沿用 CLI 时再看继承环境（官方登录已剔除该变量，不能再用环境值）。
 */
export async function detectClaudeGatewayHost(
  env: NodeJS.ProcessEnv,
  includeProcessEnv: boolean,
): Promise<string | undefined> {
  let configured: unknown;
  try {
    const settings = record(
      JSON.parse(
        await readFile(
          join(configDirectory(env, "CLAUDE_CONFIG_DIR", ".claude"), "settings.json"),
          "utf8",
        ),
      ),
    );
    configured = record(settings.env).ANTHROPIC_BASE_URL;
  } catch {
    // 文件缺失或格式错误时只视为无网关，不影响状态检测。
  }
  if (typeof configured === "string" && configured.trim())
    return gatewayHost("claude-code", configured);
  return includeProcessEnv
    ? gatewayHost("claude-code", envValue(env, "ANTHROPIC_BASE_URL"))
    : undefined;
}
