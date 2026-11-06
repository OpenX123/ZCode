import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EXTERNAL_ENGINE_CONNECTIONS_FILE,
  INHERITED_ENGINE_CONNECTION,
  externalEngineConnectionsSchema,
  type ExternalEngineConnectionProfile,
} from "@zcode/shared";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import { ExternalEngineConnectionError, type ExternalEngineSessionInput } from "@zcode/contracts";
import { createSharedZCodeCredentialStore } from "../auth/index.js";
import type { AcpConnection } from "./connection.js";

export async function resolveEngineConnection(
  root: string,
  input: ExternalEngineSessionInput,
  env: NodeJS.ProcessEnv,
): Promise<{
  profile: ExternalEngineConnectionProfile;
  env: NodeJS.ProcessEnv;
  setup?: (connection: AcpConnection) => Promise<void>;
}> {
  if (input.engine !== "codex") return { profile: INHERITED_ENGINE_CONNECTION, env };
  let profile = INHERITED_ENGINE_CONNECTION;
  try {
    const connections = externalEngineConnectionsSchema.parse(
      JSON.parse(await readFile(join(root, EXTERNAL_ENGINE_CONNECTIONS_FILE), "utf8")),
    );
    const id =
      input.connectionProfileId ??
      (input.externalSessionId ? "inherit" : connections.activeProfileId);
    const found = connections.profiles.find((item) => item.id === id);
    if (!found) throw new Error("connection_profile_missing");
    profile = found;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      (input.connectionProfileId && input.connectionProfileId !== "inherit")
    )
      throw new ExternalEngineConnectionError(
        { code: "configuration" },
        "External engine connection profile is unavailable",
      );
  }
  await input.onConnectionProfile?.(profile.id);
  if (profile.mode === "inherit") return { profile, env };
  const home = join(root, "connections", profile.id, "codex-home");
  await mkdir(home, { recursive: true });
  // 管理连接的认证与原生历史归独立目录，用户 HOME 和原 ~/.codex 保持不变。
  await atomicWritePrivateTextFile(
    join(home, "config.toml"),
    'cli_auth_credentials_store = "file"\n',
  );
  const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: home };
  // 显式管理连接不能沿用进程的网关地址，否则官方登录凭据可能被送往另一上游。
  for (const key of Object.keys(childEnv))
    if (
      [
        "APP_SERVER_LOGS",
        "DEFAULT_AUTH_REQUEST",
        "CODEX_CONFIG",
        "MODEL_PROVIDER",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "CODEX_API_KEY",
      ].includes(key.toUpperCase())
    )
      delete childEnv[key];
  if (profile.model) childEnv.CODEX_CONFIG = JSON.stringify({ model: profile.model });
  if (profile.mode === "official") return { profile, env: childEnv };
  const key = profile.credentialKey
    ? await createSharedZCodeCredentialStore({ env }).load(profile.credentialKey)
    : null;
  if (!key)
    throw new ExternalEngineConnectionError({ code: "authentication" }, "API key is missing");
  return {
    profile,
    env: childEnv,
    setup: async (connection) => {
      await connection.request("providers/set", {
        providerId: "openai",
        apiType: "openai",
        baseUrl: profile.baseUrl ?? "https://api.openai.com/v1",
        headers: { Authorization: `Bearer ${key}` },
      });
    },
  };
}
