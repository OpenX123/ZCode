import { execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import iconv from "iconv-lite";

const WINDOWS_OUTPUT_ENCODING_OVERRIDE_ENV = "ZCODE_WINDOWS_OUTPUT_ENCODING";
const WINDOWS_CODE_PAGE_QUERY_TIMEOUT_MS = 1_000;
const WINDOWS_UTF8_CODE_PAGE = "65001";
/** 按 ComSpec 缓存的活动代码页查询；在途与已完成结果共用同一个 Promise。 */
const windowsActiveCodePageQueries = new Map<string, Promise<string | null>>();
const PYTHON_UTF8_ENV_PATCH = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
} as const;

type Utf8BufferAnalysis = {
  hasNonAscii: boolean;
  incomplete: boolean;
  valid: boolean;
};

function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const foundKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return foundKey ? env[foundKey] : undefined;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    const lowerKey = key.toLowerCase();
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === lowerKey) {
        delete env[existingKey];
      }
    }
  }
  env[key] = value;
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

function resolveFallbackUtf8Locale(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const inheritedUtf8Locale = [
    getEnvValue(env, "LC_ALL", platform),
    getEnvValue(env, "LC_CTYPE", platform),
    getEnvValue(env, "LANG", platform),
  ].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;
  return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

export function applyExecutionTextEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): void {
  const fallbackLocale = resolveFallbackUtf8Locale(env, platform);

  // Bash 工具的 stdout/stderr 是给 UI 和模型消费的 Unicode 文本。
  // macOS GUI/远程 host 如果继承到 C/POSIX locale，wc、ls 等系统工具会先把中文路径替换成 "??"；
  // 这时前端已经拿不到原始字符，不能靠 React 渲染兜底恢复。这里仅在 locale 缺失或明确为 C/POSIX 时
  // 给子命令补 UTF-8 locale，并让 overlay 仍可在后面显式覆盖。
  if (isMissingOrCLocale(getEnvValue(env, "LANG", platform))) {
    setEnvKey(env, "LANG", fallbackLocale, platform);
  }
  if (isMissingOrCLocale(getEnvValue(env, "LC_CTYPE", platform))) {
    setEnvKey(env, "LC_CTYPE", fallbackLocale, platform);
  }
  const lcAll = getEnvValue(env, "LC_ALL", platform);
  if (lcAll !== undefined && isMissingOrCLocale(lcAll)) {
    setEnvKey(env, "LC_ALL", fallbackLocale, platform);
  }

  for (const [key, value] of Object.entries(PYTHON_UTF8_ENV_PATCH)) {
    setEnvKey(env, key, value, platform);
  }
}

function analyzeUtf8Buffer(buffer: Buffer): Utf8BufferAnalysis {
  let hasNonAscii = false;
  for (let index = 0; index < buffer.length; index += 1) {
    const first = buffer[index]!;
    if (first <= 0x7f) {
      continue;
    }

    hasNonAscii = true;
    let needed = 0;
    let minCodePoint = 0;
    let codePoint = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      minCodePoint = 0x80;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      minCodePoint = 0x800;
      codePoint = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      minCodePoint = 0x10000;
      codePoint = first & 0x07;
    } else {
      return { hasNonAscii, incomplete: false, valid: false };
    }

    if (index + needed >= buffer.length) {
      return { hasNonAscii, incomplete: true, valid: true };
    }

    for (let offset = 1; offset <= needed; offset += 1) {
      const next = buffer[index + offset]!;
      if ((next & 0xc0) !== 0x80) {
        return { hasNonAscii, incomplete: false, valid: false };
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }

    if (
      codePoint < minCodePoint ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return { hasNonAscii, incomplete: false, valid: false };
    }

    index += needed;
  }

  return { hasNonAscii, incomplete: false, valid: true };
}

export function decodeExecutionOutputBuffer(
  buffer: Buffer,
  legacyOutputEncoding: string | null = null,
): string {
  if (buffer.length === 0) return "";
  const analysis = analyzeUtf8Buffer(buffer);
  if (!legacyOutputEncoding || (analysis.valid && !analysis.incomplete)) {
    return buffer.toString("utf8");
  }
  return iconv.decode(buffer, legacyOutputEncoding);
}

export function createExecutionOutputStreamDecoder(legacyOutputEncoding: string | null) {
  if (!legacyOutputEncoding) {
    const decoder = new StringDecoder("utf8");
    return {
      write: (buffer: Buffer) => decoder.write(buffer),
    };
  }

  const utf8Decoder = new StringDecoder("utf8");
  const legacyDecoder = iconv.getDecoder(legacyOutputEncoding);
  let pending: Buffer = Buffer.alloc(0);
  let mode: "unknown" | "utf8" | "legacy" = "unknown";

  return {
    write(buffer: Buffer): string {
      if (mode === "utf8") {
        return utf8Decoder.write(buffer);
      }
      if (mode === "legacy") {
        return legacyDecoder.write(buffer);
      }

      const combined = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer;
      const analysis = analyzeUtf8Buffer(combined);
      if (!analysis.valid) {
        mode = "legacy";
        pending = Buffer.alloc(0);
        return legacyDecoder.write(combined);
      }
      if (analysis.incomplete) {
        pending = combined;
        return "";
      }

      pending = Buffer.alloc(0);
      if (analysis.hasNonAscii) {
        mode = "utf8";
        return utf8Decoder.write(combined);
      }
      return combined.toString("utf8");
    },
  };
}

function parseWindowsCodePageEncoding(output: string): string | null {
  const codePage = output.match(/(\d{3,5})/)?.[1];
  if (!codePage) return null;
  if (codePage === WINDOWS_UTF8_CODE_PAGE) return "utf8";
  const encoding = `cp${codePage}`;
  return iconv.encodingExists(encoding) ? encoding : null;
}

function readWindowsActiveCodePageEncoding(env: NodeJS.ProcessEnv): Promise<string | null> {
  const comSpec = getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe";
  const cached = windowsActiveCodePageQueries.get(comSpec);
  if (cached) return cached;
  // 原因：旧实现在每次工具执行前同步 execFileSync("chcp")，Windows 上每次都阻塞 CLI 事件循环
  // 数十毫秒，期间所有会话的流式事件与命令都无法处理。新建的隐藏控制台使用系统 OEM 代码页，
  // 进程生命周期内不变，因此每个进程按 ComSpec 只异步查询一次；失败同样缓存为 null，
  // 由调用方回退 locale 推断，避免每次执行重复超时。
  const query = new Promise<string | null>((resolve) => {
    try {
      execFile(
        comSpec,
        ["/d", "/s", "/c", "chcp"],
        { encoding: "utf8", env, timeout: WINDOWS_CODE_PAGE_QUERY_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? null : parseWindowsCodePageEncoding(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
  windowsActiveCodePageQueries.set(comSpec, query);
  return query;
}

function resolveWindowsLocaleLegacyEncoding(env: NodeJS.ProcessEnv): string {
  const localeText = [
    getEnvValue(env, "LC_ALL", "win32"),
    getEnvValue(env, "LC_CTYPE", "win32"),
    getEnvValue(env, "LANG", "win32"),
    Intl.DateTimeFormat().resolvedOptions().locale,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/(zh|chinese|cn|hans|hant)/i.test(localeText)) {
    return "gb18030";
  }
  if (/(ja|japanese|jp)/i.test(localeText)) {
    return "cp932";
  }
  if (/(ko|korean|kr)/i.test(localeText)) {
    return "cp949";
  }
  if (/(ru|russian)/i.test(localeText)) {
    return "cp866";
  }
  return "cp437";
}

export async function resolveLegacyExecutionOutputEncoding(options: {
  platform: NodeJS.Platform;
  processEnv: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (options.platform !== "win32") {
    return null;
  }
  const override = getEnvValue(
    options.processEnv,
    WINDOWS_OUTPUT_ENCODING_OVERRIDE_ENV,
    "win32",
  )?.trim();
  if (override) {
    return iconv.encodingExists(override) ? override : null;
  }
  const activeEncoding = await readWindowsActiveCodePageEncoding(options.processEnv);
  if (activeEncoding && activeEncoding !== "utf8") {
    return activeEncoding;
  }
  return resolveWindowsLocaleLegacyEncoding(options.processEnv);
}
