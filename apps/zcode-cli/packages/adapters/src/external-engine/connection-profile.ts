import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CODEX_OFFICIAL_BASE_URL,
  EXTERNAL_ENGINE_CONNECTIONS_FILE,
  buildEngineConnectionEnv,
  engineConnectionCodexHomeSegments,
  externalEngineConnectionsSchema,
  findEngineConnectionProfile,
  resolveEngineConnectionProfileId,
  type ExternalEngineConnectionProfile,
  type ExternalEngineConnections,
} from "@zcode/shared";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import { ExternalEngineConnectionError, type ExternalEngineSessionInput } from "@zcode/contracts";
import { createSharedZCodeCredentialStore } from "../auth/index.js";
import type { AcpConnection } from "./connection.js";

async function readConnections(root: string): Promise<ExternalEngineConnections | undefined> {
  try {
    return externalEngineConnectionsSchema.parse(
      JSON.parse(await readFile(join(root, EXTERNAL_ENGINE_CONNECTIONS_FILE), "utf8")),
    );
  } catch (error) {
    // 从未保存过连接时只有内置配置；文件损坏不能静默回落到另一身份。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ExternalEngineConnectionError(
      { code: "configuration" },
      "External engine connection profile is unavailable",
    );
  }
}

/**
 * 按会话绑定解析连接身份并构造 adapter 环境。规则由共享 buildEngineConnectionEnv 唯一定义；
 * 这里只负责读取 Host 写入的配置文件、专用 CODEX_HOME 与凭据，CLI 不写连接配置。
 */
export async function resolveEngineConnection(
  root: string,
  input: ExternalEngineSessionInput,
  env: NodeJS.ProcessEnv,
): Promise<{
  profile: ExternalEngineConnectionProfile;
  env: NodeJS.ProcessEnv;
  setup?: (connection: AcpConnection) => Promise<void>;
}> {
  const connections = await readConnections(root);
  const id = resolveEngineConnectionProfileId(connections, input);
  const profile = findEngineConnectionProfile(connections, input.engine, id);
  if (!profile)
    throw new ExternalEngineConnectionError(
      { code: "configuration" },
      "External engine connection profile is unavailable",
    );
  await input.onConnectionProfile?.(profile.id);
  let codexHome: string | undefined;
  if (input.engine === "codex" && profile.mode !== "inherit") {
    codexHome = join(root, ...engineConnectionCodexHomeSegments(profile.id));
    await mkdir(codexHome, { recursive: true });
    // 管理连接的认证与原生历史归独立目录，用户 HOME 和原 ~/.codex 保持不变。
    await atomicWritePrivateTextFile(
      join(codexHome, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
    );
  }
  const key =
    profile.mode === "apiKey" && profile.credentialKey
      ? await createSharedZCodeCredentialStore({ env }).load(profile.credentialKey)
      : null;
  if (profile.mode === "apiKey" && !key)
    throw new ExternalEngineConnectionError({ code: "authentication" }, "API key is missing");
  const childEnv = buildEngineConnectionEnv({
    env,
    profile,
    codexHome,
    // Codex 密钥只经私有 providers/set；Claude 官方 CLI 只能从子进程环境读取密钥。
    ...(input.engine === "claude-code" && key ? { apiKey: key } : {}),
  });
  if (input.engine !== "codex" || profile.mode !== "apiKey" || !key)
    return { profile, env: childEnv };
  return {
    profile,
    env: childEnv,
    setup: async (connection) => {
      await connection.request("providers/set", {
        providerId: "openai",
        apiType: "openai",
        baseUrl: profile.baseUrl ?? CODEX_OFFICIAL_BASE_URL,
        headers: { Authorization: `Bearer ${key}` },
      });
    },
  };
}
