import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_WORKSPACE_IDENTITY_ENV,
} from "@zcode/shared";

// 把设置页的 HTTP 代理、No Proxy 和自定义 CA 翻译成 agent 子进程的环境变量补丁。
// agent 是子进程，继承宿主 process.env；这里在 spawn 时把代理与证书注入进去，所以「下次启动 agent」生效。
//
// 代理：设置大写标准三件套保证设置页优先于继承来的同名 shell 变量（model registry 按 HTTPS_PROXY →
// HTTP_PROXY → … 先匹配大写）；额外设 ZCODE_HTTP_PROXY 让 Bash 工具子进程经 subprocess-env 拿到最高优先级。
//
// No Proxy：只接受设置页显式填写的绕过规则。额外设 ZCODE_NO_PROXY 让 provider/http adapter
// 能在不读取用户 shell NO_PROXY 的前提下复用同一套规则。
//
// 自定义证书：只接受设置页显式填写的 PEM 路径。注入 NODE_EXTRA_CA_CERTS 让 agent（含模型 provider 请求）
// 在 Node 启动时信任它，同时用 ZCODE_AGENT_CA_CERT 给 adapter 和工具子进程补齐跨运行时 CA 变量。

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  ZCODE_HTTP_PROXY_ENV_KEY,
] as const;
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy", ZCODE_NO_PROXY_ENV_KEY] as const;

export function buildAgentProxyEnv(httpProxy: string | undefined): Record<string, string> {
  const normalized = normalizeProxyValue(httpProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

export function buildAgentCaCertEnv(caCertPath: string | undefined): Record<string, string> {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return {};
  }
  return {
    // NODE_EXTRA_CA_CERTS 必须在 Node 进程启动前存在；ZCODE_AGENT_CA_CERT 则给运行时配置、
    // provider fetch 和工具子进程使用，避免清洗标准 CA 环境后丢失 app 显式注入的证书路径。
    NODE_EXTRA_CA_CERTS: trimmed,
    [ZCODE_AGENT_CA_CERT_ENV_KEY]: trimmed,
  };
}

export function buildAgentNoProxyEnv(noProxy: string | undefined): Record<string, string> {
  const normalized = normalizeNoProxyValue(noProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of NO_PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

/**
 * spawn agent 时一次性解析的运行时 env 补丁：代理 + No Proxy + 自定义 CA。
 * 这些值都只来自 AppSettings 显式配置；用户 shell 里的标准代理/证书变量已经在上游清洗。
 */
export function buildAgentRuntimeEnv(input: {
  httpProxy: string | undefined;
  noProxy?: string | undefined;
  caCertPath?: string | undefined;
}): Record<string, string> {
  const proxyEnv = buildAgentProxyEnv(input.httpProxy);
  return {
    ...proxyEnv,
    ...buildAgentNoProxyEnv(input.noProxy),
    ...buildAgentCaCertEnv(input.caCertPath),
  };
}

/** 把 Host 已知的 remote workspace identity 注入对应 Agent；本地 workspace 保持 path fallback。 */
export function buildAgentWorkspaceIdentityEnv(
  workspaceIdentity: string | undefined,
): Record<string, string> {
  const trimmed = workspaceIdentity?.trim();
  return trimmed ? { [ZCODE_WORKSPACE_IDENTITY_ENV]: trimmed } : {};
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // 已带 scheme（http://、socks5:// 等）原样保留；裸 host:port 补 http://。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeNoProxyValue(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}
