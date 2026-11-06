import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { managedAdapterEntrySegments, type ExternalEngineRuntimeDescriptor } from "../contract.js";

/** npm / pnpm 生成的 Windows 包装入口里接收用户参数的目标：`"%dp0%\<相对路径>" %*`。 */
const WINDOWS_SHIM_TARGET = /"(?:%dp0%|%~dp0)[\\/]+([^"\r\n]+\.(?:exe|[cm]?js))"\s+%\*/i;
/** 官方 `@openai/codex/bin/codex.js` 只负责选择并 spawn 平台包内的原生 codex.exe。 */
const CODEX_NPM_LAUNCHER = /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i;
/** 与上游 codex.js 的 PLATFORM_PACKAGE_BY_TARGET 一致：Windows 架构 → target triple。 */
const CODEX_WINDOWS_TARGETS: Readonly<Record<string, string>> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按官方 codex.js 的查找顺序定位原生文件：从脚本真实路径沿 node_modules 链查找
 * `@openai/codex-win32-<arch>`（npm 嵌套、提升与 pnpm 虚拟仓库布局），再回退包内 vendor。
 */
async function resolveCodexWindowsExecutable(
  launcher: string,
  arch: string,
): Promise<string | undefined> {
  const target = CODEX_WINDOWS_TARGETS[arch];
  if (!target) return undefined;
  let script: string;
  try {
    script = await realpath(launcher);
  } catch {
    return undefined;
  }
  const binary = ["vendor", target, "bin", "codex.exe"];
  const candidates: string[] = [];
  for (let directory = dirname(script); ; directory = dirname(directory)) {
    if (basename(directory).toLowerCase() !== "node_modules")
      candidates.push(join(directory, "node_modules", "@openai", `codex-win32-${arch}`, ...binary));
    if (dirname(directory) === directory) break;
  }
  candidates.push(join(dirname(dirname(script)), ...binary));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return undefined;
}

/**
 * 官方 CLI 的 Windows 包装入口按其目标解析；返回 null 表示该入口不可用，继续查找 PATH。
 * 其它命令（npm、node 等）保持包装入口本身，由调用方按批处理执行。
 */
async function resolveWindowsEngineShim(
  command: string,
  shim: string,
  directory: string,
  arch: string,
): Promise<string | null> {
  if (command !== "claude" && command !== "codex") return shim;
  let content: string;
  try {
    content = await readFile(shim, "utf8");
  } catch {
    // Codex adapter 的 cross-spawn 可直接执行 .cmd；读不到内容时保持原行为。
    return command === "codex" ? shim : null;
  }
  const relative = WINDOWS_SHIM_TARGET.exec(content)?.[1];
  const target = relative ? join(directory, ...relative.split(/[\\/]/)) : undefined;
  if (!target || !(await exists(target))) {
    // 锁定的 Claude SDK 直接 spawn，不支持批处理；无法识别的入口视为不可用。
    return command === "codex" ? shim : null;
  }
  // 原因：Claude 2.x 的 npm 入口指向原生 claude.exe，旧规则只认 .js，导致跳过用户 PATH 中的官方
  // CLI 而改用 adapter 自带副本，违反“优先使用用户 PATH 中的官方 CLI”。目标为 .exe 时直接使用。
  if (/\.exe$/i.test(target) || command === "claude") return target;
  // 原因：Codex 的 npm 入口经 cmd.exe → node.exe codex.js 再启动原生 codex.exe，每次检测与
  // 连接都多启动两个进程；按 codex.js 的同一查找规则直接返回原生文件，找不到时保留 .cmd。
  if (CODEX_NPM_LAUNCHER.test(target))
    return (await resolveCodexWindowsExecutable(target, arch)) ?? shim;
  return shim;
}

/** 检测和执行共用 PATH/PATHEXT 规则，避免 Windows 检查用户 shim 却执行另一份 CLI。 */
export async function resolveExternalEngineCli(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string | undefined> {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const pathExtKey = Object.keys(env).find((key) => key.toUpperCase() === "PATHEXT");
  const extensions =
    platform === "win32"
      ? (env[pathExtKey ?? "PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of (env[pathKey ?? "PATH"] ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        if (platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate)) {
          const resolved = await resolveWindowsEngineShim(command, candidate, directory, arch);
          if (resolved === null) continue;
          return resolved;
        }
        return candidate;
      } catch {
        // 不执行 CLI，也不读取任何账号信息。
      }
    }
  }
  return undefined;
}

/** 状态检测和实际连接共用同一官方入口；SDK 原生包必须从锁定 adapter 的依赖树解析。 */
export async function resolveExternalEngineLaunch(
  runtime: ExternalEngineRuntimeDescriptor,
  env: NodeJS.ProcessEnv,
  installDir?: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string | undefined> {
  const onPath = await resolveExternalEngineCli(runtime.officialCliCommand, env, platform, arch);
  if (onPath || !installDir) return onPath;
  const bundled = runtime.bundledOfficialCli;
  try {
    if (bundled.kind === "javascript") {
      const entry = join(installDir, ...bundled.entry.split("/"));
      await access(entry, constants.F_OK);
      return entry;
    }
    const adapterRequire = createRequire(join(installDir, ...managedAdapterEntrySegments(runtime)));
    const sdkRequire = createRequire(adapterRequire.resolve(bundled.package));
    const report =
      platform === "linux"
        ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
        : undefined;
    const variants =
      platform === "linux"
        ? report?.header?.glibcVersionRuntime
          ? ["", "-musl"]
          : ["-musl", ""]
        : [""];
    for (const variant of variants) {
      try {
        const entry = sdkRequire.resolve(
          `${bundled.package}-${platform}-${arch}${variant}/${bundled.binary}${platform === "win32" ? ".exe" : ""}`,
        );
        await access(entry, constants.F_OK);
        return entry;
      } catch {
        // 上游 SDK 同样先选匹配 libc，再尝试已安装的另一种发行包。
      }
    }
  } catch {
    // adapter 或对应平台 optional 包尚未安装。
  }
  return undefined;
}
