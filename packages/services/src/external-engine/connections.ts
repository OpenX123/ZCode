import { randomUUID } from "node:crypto";
import { access, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  ANTHROPIC_OFFICIAL_BASE_URL,
  CODEX_OFFICIAL_BASE_URL,
  EXTERNAL_ENGINE_CONNECTIONS_FILE,
  INHERIT_ENGINE_CONNECTION_ID,
  builtInEngineConnectionProfiles,
  engineConnectionCodexHomeSegments,
  engineConnectionCredentialKey,
  engineConnectionGatewayHost,
  externalEngineConnectionProfileSchema,
  externalEngineConnectionViewSchema,
  externalEngineConnectionsSchema,
  findEngineConnectionProfile,
  lastUsedEngineConnectionProfileId,
  type ExternalEngineConnectionCommand,
  type ExternalEngineConnectionProfile,
  type ExternalEngineConnections,
  type ExternalEngineConnectionsView,
  type ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import type { ICredentialService } from "../credential/credential.js";

const EMPTY_CONNECTIONS: ExternalEngineConnections = {
  activeProfileId: INHERIT_ENGINE_CONNECTION_ID,
  profiles: [],
};

function normalizeBaseUrl(engine: ExternalSessionEngine, value: string | undefined): string {
  const raw =
    value?.trim() || (engine === "codex" ? CODEX_OFFICIAL_BASE_URL : ANTHROPIC_OFFICIAL_BASE_URL);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("external_engine_connection_url_invalid");
  }
  // 地址会进入状态与列表显示；拒绝内嵌账号、查询和片段，避免凭据混入非机密字段。
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("external_engine_connection_url_invalid");
  return url.toString().replace(/\/$/, "");
}

/** Host 是连接配置唯一写者：所有写入在文件锁内读改写并原子落盘，密钥只进 CredentialService。 */
export function createEngineConnections(enginesDir: string, credentials?: ICredentialService) {
  const file = join(enginesDir, EXTERNAL_ENGINE_CONNECTIONS_FILE);
  const managedCodexAuthProfiles = new Set<string>();
  const read = async (): Promise<ExternalEngineConnections> => {
    try {
      return externalEngineConnectionsSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY_CONNECTIONS);
      throw new Error("external_engine_connections_unreadable");
    }
  };
  const hasManagedCodexAuth = async (profileId: string): Promise<boolean> => {
    if (managedCodexAuthProfiles.has(profileId)) return true;
    try {
      await access(join(enginesDir, ...engineConnectionCodexHomeSegments(profileId), "auth.json"));
      return true;
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return false;
      throw error;
    }
  };
  const resolveDefaultProfileId = async (
    connections: ExternalEngineConnections,
    engine: ExternalSessionEngine,
  ): Promise<string> => {
    const candidate = lastUsedEngineConnectionProfileId(connections, engine);
    // Codex 官方配置首次创建时还没有专用 auth.json。此时沿用本地 CLI 身份，
    // 避免用户已经在 ~/.codex 登录却被空的 YCode 专用目录挡住；应用内登录完成后，
    // 专用目录出现凭据，下一次读取自然恢复到该配置。
    if (engine === "codex" && candidate !== INHERIT_ENGINE_CONNECTION_ID) {
      const profile = findEngineConnectionProfile(connections, engine, candidate);
      if (profile?.mode === "official" && !(await hasManagedCodexAuth(profile.id)))
        return INHERIT_ENGINE_CONNECTION_ID;
    }
    return candidate;
  };
  const view = async (connections: ExternalEngineConnections): Promise<ExternalEngineConnectionsView> => {
    // 视图 schema 不含 credentialKey，解析即剥离凭据定位信息。
    const visible = (profile: ExternalEngineConnectionProfile, builtIn: boolean) => {
      const gatewayHost = engineConnectionGatewayHost(profile);
      return externalEngineConnectionViewSchema.parse({
        ...profile,
        ...(builtIn ? { builtIn } : {}),
        ...(gatewayHost ? { gatewayHost } : {}),
      });
    };
    const engines: ExternalSessionEngine[] = ["claude-code", "codex"];
    const [claudeDefault, codexDefault] = await Promise.all([
      resolveDefaultProfileId(connections, "claude-code"),
      resolveDefaultProfileId(connections, "codex"),
    ]);
    return {
      defaults: {
        "claude-code": claudeDefault,
        codex: codexDefault,
      },
      profiles: [
        ...engines.flatMap((engine) =>
          builtInEngineConnectionProfiles(engine).map((profile) => visible(profile, true)),
        ),
        ...connections.profiles
          .filter((profile) => profile.id !== INHERIT_ENGINE_CONNECTION_ID)
          .map((profile) => visible(profile, false)),
      ],
    };
  };
  const write = async (connections: ExternalEngineConnections) => {
    // 回退到 1.0.7 时旧 CLI 只认 activeProfileId 且要求 inherit 条目存在。
    const profiles = connections.profiles.some(
      (profile) => profile.id === INHERIT_ENGINE_CONNECTION_ID,
    )
      ? connections.profiles
      : [...builtInEngineConnectionProfiles("codex"), ...connections.profiles];
    await atomicWritePrivateTextFile(
      file,
      JSON.stringify({
        ...connections,
        activeProfileId: lastUsedEngineConnectionProfileId(connections, "codex"),
        profiles,
      }),
    );
  };
  const requireProfile = (
    connections: ExternalEngineConnections,
    engine: ExternalSessionEngine,
    id: string,
  ) => {
    const profile = findEngineConnectionProfile(connections, engine, id);
    if (!profile || profile.hidden) throw new Error("external_engine_connection_invalid");
    return profile;
  };
  const update = async (
    command: ExternalEngineConnectionCommand,
  ): Promise<{ connections: ExternalEngineConnectionsView; profileId?: string }> => {
    await mkdir(enginesDir, { recursive: true });
    // 新密钥在落盘配置前写入凭据；配置写入失败时删除，避免留下无主密钥。
    let savedCredential: string | undefined;
    try {
      return await withFileLock(file, async () => {
        const current = await read();
        const lastUsed = { ...current.lastUsed };
        if (command.type === "select") {
          lastUsed[command.engine] = requireProfile(current, command.engine, command.profileId).id;
          const next = { ...current, lastUsed };
          await write(next);
          return { connections: await view(next) };
        }
        if (command.type === "delete") {
          const target = requireProfile(current, command.engine, command.profileId);
          if (builtInEngineConnectionProfiles(command.engine).some((item) => item.id === target.id))
            throw new Error("external_engine_connection_invalid");
          // 删除只隐藏：已绑定会话仍按 ID 解析，目录与凭据不自动清理。
          if (lastUsed[command.engine] === target.id) delete lastUsed[command.engine];
          const next = {
            ...current,
            lastUsed,
            profiles: current.profiles.map((item) =>
              item === target ? { ...item, hidden: true } : item,
            ),
          };
          await write(next);
          return { connections: await view(next) };
        }
        if (command.mode === "inherit") throw new Error("external_engine_connection_invalid");
        const previous =
          command.type === "edit"
            ? requireProfile(current, command.engine, command.profileId)
            : undefined;
        if (
          previous &&
          (previous.mode !== command.mode ||
            builtInEngineConnectionProfiles(command.engine).some((item) => item.id === previous.id))
        )
          throw new Error("external_engine_connection_invalid");
        const id = randomUUID();
        const credentialKey =
          command.mode === "apiKey" ? engineConnectionCredentialKey(command.engine, id) : undefined;
        let apiKey = command.apiKey?.trim();
        if (command.mode === "apiKey") {
          if (!apiKey && previous?.credentialKey && credentials)
            apiKey = (await credentials.load(previous.credentialKey)) ?? undefined;
          if (!apiKey || !credentials) throw new Error("external_engine_api_key_missing");
        }
        const profile = externalEngineConnectionProfileSchema.parse({
          id,
          engine: command.engine,
          ...(command.name?.trim() ? { name: command.name.trim() } : {}),
          mode: command.mode,
          ...(command.mode === "apiKey"
            ? {
                baseUrl: normalizeBaseUrl(command.engine, command.baseUrl),
                credentialKey,
                hasApiKey: true,
              }
            : {}),
          ...(command.model?.trim() ? { model: command.model.trim() } : {}),
        });
        if (credentialKey) {
          await credentials!.save(credentialKey, apiKey!);
          savedCredential = credentialKey;
        }
        // 编辑生成新 ID，旧配置隐藏但保留，已有会话继续使用旧绑定；新建或编辑当前缺省时
        // 新 ID 成为上次使用（1.0.7 的旧 activeProfileId 同样按解析后的缺省比较）。
        if (!previous || lastUsedEngineConnectionProfileId(current, command.engine) === previous.id)
          lastUsed[command.engine] = id;
        const next = {
          ...current,
          lastUsed,
          profiles: [
            ...current.profiles.map((item) =>
              item === previous ? { ...item, hidden: true } : item,
            ),
            profile,
          ],
        };
        await write(next);
        savedCredential = undefined;
        return { connections: await view(next), profileId: id };
      });
    } finally {
      if (savedCredential) await credentials!.delete(savedCredential).catch(() => {});
    }
  };
  return {
    read,
    readView: async () => view(await read()),
    defaultProfileId: async (engine: ExternalSessionEngine) =>
      resolveDefaultProfileId(await read(), engine),
    update,
    markManagedCodexAuth: (profileId: string) => {
      managedCodexAuthProfiles.add(profileId);
    },
    home: (id: string) => join(enginesDir, ...engineConnectionCodexHomeSegments(id)),
  };
}
