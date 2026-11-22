// Env Config Adapter - Parse the intentionally small ZCODE_* environment surface.

import type { RuntimeConfigPatch } from "@zcode/contracts";
import { readYCodeEnv } from "@zcode/shared/ycode-data-root";

interface EnvConfigOptions {
  prefix?: string;
}

const DEFAULT_PREFIX = "ZCODE_";

/**
 * Parse ZCODE_* environment variables into config
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): RuntimeConfigPatch {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const config: RuntimeConfigPatch = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;

    const configKey = key.slice(prefix.length);
    // Storage config
    if (configKey === "STORAGE_DIR") {
      if (!config.storage) config.storage = {};
      config.storage.dir = value;
    } else if (configKey === "SESSION_DB_PATH" || configKey === "SESSION_DB") {
      if (!config.storage) config.storage = {};
      config.storage.sessionDbPath = value;
    }

    // Network config
    else if (configKey === "HTTP_PROXY") {
      if (!config.network) config.network = {};
      config.network.httpProxy = value;
    } else if (configKey === "NO_PROXY") {
      if (!config.network) config.network = {};
      config.network.noProxy = value;
    } else if (configKey === "AGENT_CA_CERT") {
      if (!config.network) config.network = {};
      config.network.caCertFile = value;
    } else if (configKey === "HTTP_TIMEOUT" || configKey === "TIMEOUT") {
      if (!config.network) config.network = {};
      config.network.timeout = normalizeNumber(value);
    }

    // Logging config
    else if (configKey === "LOG_FORMAT") {
      if (!config.logging) config.logging = {};
      config.logging.format = normalizeLogFormat(value);
    }

    // Tool Concurrency config
    else if (configKey === "MAX_TOOL_CONCURRENCY") {
      if (!config.toolConcurrency) config.toolConcurrency = {};
      config.toolConcurrency.maxConcurrency = normalizeNumber(value);
    }
  }

  // YCODE_STORAGE_DIR / YCODE_SESSION_DB_PATH 优先于旧 ZCODE_ 名称（docs/desktop/ycode-data-dir-migration.md）。
  if (prefix === DEFAULT_PREFIX) {
    const storageDir = readYCodeEnv(env, "STORAGE_DIR");
    const sessionDbPath = readYCodeEnv(env, "SESSION_DB_PATH");
    if (storageDir) {
      config.storage = { ...config.storage, dir: storageDir };
    }
    if (sessionDbPath) {
      config.storage = { ...config.storage, sessionDbPath };
    }
  }

  return config;
}

/**
 * Get tool concurrency config from environment
 */
export function getToolConcurrencyConfig(): { maxConcurrency: number } {
  return {
    maxConcurrency: normalizeNumber(process.env.ZCODE_MAX_TOOL_CONCURRENCY ?? "10"),
  };
}

// ============================================================
// Helpers
// ============================================================

function normalizeNumber(value: string): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function normalizeLogFormat(value: string): "text" | "json" {
  const format = value.toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  return "text";
}
