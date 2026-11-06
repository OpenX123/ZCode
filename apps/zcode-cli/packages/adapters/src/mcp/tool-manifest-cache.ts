import type { Logger, McpServerConfig, McpToolDescriptor } from "@zcode/contracts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * MCP 工具清单缓存：按 server 解析后配置的指纹保存上次成功的 `tools/list`（规则见
 * docs/design/v2/mcp.md「会话启动：工具清单缓存与首次使用时启动」）。
 *
 * 指纹只取配置的结构与 env / header 的**键名**；env、header、OAuth 的值（可能是密钥）既不参与
 * 指纹也不写入文件。文件内容只有指纹、server 名、保存时间与工具描述。全部为异步 IO。
 */
export interface McpToolManifestCache {
  /** 读取缓存清单；缺失、损坏或与指纹不符时返回 undefined。 */
  read(serverName: string, config: McpServerConfig): Promise<McpToolDescriptor[] | undefined>;
  /** 写入真实清单；与本进程已知内容相同时不写盘。失败只记 warn，不抛错。 */
  write(
    serverName: string,
    config: McpServerConfig,
    tools: readonly McpToolDescriptor[],
  ): Promise<void>;
  /** 删除该指纹的缓存（启动失败时调用）。 */
  invalidate(serverName: string, config: McpServerConfig): Promise<void>;
}

export interface CreateMcpToolManifestCacheOptions {
  appVersion: string;
  logger?: Logger;
  /** 目录内文件数上限，超出按 mtime 淘汰最旧文件。 */
  maxEntries?: number;
  rootDir: string;
}

interface ToolManifestFile {
  fingerprint: string;
  savedAt: string;
  serverName: string;
  tools: McpToolDescriptor[];
  version: typeof TOOL_MANIFEST_FILE_VERSION;
}

const TOOL_MANIFEST_FILE_VERSION = 1;
const TOOL_MANIFEST_FINGERPRINT_VERSION = 1;
const TOOL_MANIFEST_FILE_SUFFIX = ".json";
const DEFAULT_MAX_TOOL_MANIFEST_ENTRIES = 128;
// 只有插件身份与插件根目录这两个非密钥 env 值参与指纹：前者区分插件，后者含版本目录。
const PLUGIN_IDENTITY_ENV_KEYS = ["ZCODE_PLUGIN_ID", "ZCODE_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"];

export function createFileMcpToolManifestCache(
  options: CreateMcpToolManifestCacheOptions,
): McpToolManifestCache {
  const logger = options.logger?.child({ module: "adapters.mcp.tool_manifest_cache" });
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_TOOL_MANIFEST_ENTRIES;
  // 指纹 → 最近一次读到或写入的清单签名；同内容重复连接不重复写盘。
  const knownSignatures = new Map<string, string>();
  const pathFor = (fingerprint: string) =>
    join(options.rootDir, `${fingerprint}${TOOL_MANIFEST_FILE_SUFFIX}`);

  const prune = async (): Promise<void> => {
    const entries = (await readdir(options.rootDir)).filter((name) =>
      name.endsWith(TOOL_MANIFEST_FILE_SUFFIX),
    );
    if (entries.length <= maxEntries) return;
    const withTimes = await Promise.all(
      entries.map(async (name) => {
        const path = join(options.rootDir, name);
        try {
          return { mtimeMs: (await stat(path)).mtimeMs, path };
        } catch {
          return { mtimeMs: 0, path };
        }
      }),
    );
    withTimes.sort((left, right) => left.mtimeMs - right.mtimeMs);
    await Promise.all(
      withTimes
        .slice(0, withTimes.length - maxEntries)
        .map((entry) => rm(entry.path, { force: true })),
    );
  };

  return {
    async read(serverName, config) {
      const fingerprint = computeMcpServerFingerprint(serverName, config, options.appVersion);
      try {
        const parsed = JSON.parse(await readFile(pathFor(fingerprint), "utf8")) as unknown;
        const manifest = parseToolManifestFile(parsed, fingerprint, serverName);
        if (!manifest) return undefined;
        knownSignatures.set(fingerprint, toolManifestSignature(manifest.tools));
        return manifest.tools;
      } catch {
        // 缺失或损坏都按未命中处理：该 server 改为后台连接，不影响首个请求。
        return undefined;
      }
    },
    async write(serverName, config, tools) {
      const fingerprint = computeMcpServerFingerprint(serverName, config, options.appVersion);
      const signature = toolManifestSignature(tools);
      if (knownSignatures.get(fingerprint) === signature) return;
      knownSignatures.set(fingerprint, signature);
      const file: ToolManifestFile = {
        fingerprint,
        savedAt: new Date().toISOString(),
        serverName,
        tools: tools.map((tool) => ({ ...tool })),
        version: TOOL_MANIFEST_FILE_VERSION,
      };
      const target = pathFor(fingerprint);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(options.rootDir, { recursive: true });
        await writeFile(temporary, `${JSON.stringify(file)}\n`, "utf8");
        await rename(temporary, target);
        await prune();
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        knownSignatures.delete(fingerprint);
        logger?.warn("MCP tool manifest cache write failed", {
          errorCode: (error as NodeJS.ErrnoException).code,
          event: "mcp.manifest_cache.write_failed",
          mcpServerName: serverName,
          status: "failed",
        });
      }
    },
    async invalidate(serverName, config) {
      const fingerprint = computeMcpServerFingerprint(serverName, config, options.appVersion);
      knownSignatures.delete(fingerprint);
      await rm(pathFor(fingerprint), { force: true }).catch((error: unknown) => {
        logger?.warn("MCP tool manifest cache invalidation failed", {
          errorCode: (error as NodeJS.ErrnoException).code,
          event: "mcp.manifest_cache.invalidate_failed",
          mcpServerName: serverName,
          status: "failed",
        });
      });
    },
  };
}

/**
 * server 解析后配置的指纹。只含结构与键名；`enabled` 不参与（停用的 server 不会读写缓存），
 * env / header / OAuth 的值不参与，避免密钥轮换导致缓存失效，也避免把密钥带进任何派生值。
 */
export function computeMcpServerFingerprint(
  serverName: string,
  config: McpServerConfig,
  appVersion: string,
): string {
  const transport =
    config.type === "stdio"
      ? {
          args: config.args ?? [],
          command: config.command,
          cwd: config.cwd ?? null,
          envKeys: Object.keys(config.env ?? {}).toSorted(),
          plugin: PLUGIN_IDENTITY_ENV_KEYS.map((key) => config.env?.[key] ?? null),
        }
      : {
          headerKeys: Object.keys(config.headers ?? {})
            .map((key) => key.toLowerCase())
            .toSorted(),
          oauth: config.oauth?.type ?? null,
          url: redactUrl(config.url),
        };
  return createHash("sha256")
    .update(
      JSON.stringify({
        alwaysLoad: config.alwaysLoad ?? null,
        appVersion,
        isolation: config.isolation ?? null,
        protocolVersion: config.protocolVersion ?? null,
        serverName,
        source: config.source?.kind ?? null,
        timeoutMs: config.timeoutMs ?? null,
        transport,
        type: config.type,
        version: TOOL_MANIFEST_FINGERPRINT_VERSION,
      }),
    )
    .digest("hex");
}

/** 工具清单的完整签名（含 schema、注解与 UI 元数据），用于判定真实清单是否漂移。 */
export function toolManifestSignature(tools: readonly McpToolDescriptor[]): string {
  return tools
    .map((tool) => stableStringify(tool))
    .toSorted()
    .join("\n");
}

function parseToolManifestFile(
  value: unknown,
  fingerprint: string,
  serverName: string,
): ToolManifestFile | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== TOOL_MANIFEST_FILE_VERSION ||
    value.fingerprint !== fingerprint ||
    value.serverName !== serverName ||
    typeof value.savedAt !== "string" ||
    !Array.isArray(value.tools)
  ) {
    return undefined;
  }
  const tools = value.tools;
  if (!tools.every((tool) => isToolDescriptor(tool, serverName))) return undefined;
  return value as unknown as ToolManifestFile;
}

function isToolDescriptor(value: unknown, serverName: string): value is McpToolDescriptor {
  return (
    isRecord(value) &&
    value.serverName === serverName &&
    typeof value.toolName === "string" &&
    value.toolName.length > 0 &&
    isRecord(value.inputSchema)
  );
}

/** 只保留 scheme + host + path：query、fragment 与 userinfo 可能携带令牌。 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
