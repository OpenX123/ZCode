import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { managedAdapterEntrySegments, type ExternalEngineRuntimeDescriptor } from "../contract.js";

/** 检测和执行共用 PATH/PATHEXT 规则，避免 Windows 检查用户 shim 却执行另一份 CLI。 */
export async function resolveExternalEngineCli(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
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
      let candidate = join(directory, `${command}${extension}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        if (platform === "win32" && command === "claude" && /\.(?:cmd|bat)$/i.test(candidate)) {
          // 锁定的 Claude SDK 直接 spawn，不支持批处理；只解开 npm/pnpm 的同份安装入口。
          const shim = await readFile(candidate, "utf8");
          const script = /"(?:%dp0%|%~dp0)[\\/]+([^"\r\n]+\.m?js)"\s+%\*/i.exec(shim)?.[1];
          if (!script) continue;
          candidate = join(directory, ...script.split(/[\\/]/));
          await access(candidate, constants.F_OK);
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
  const onPath = await resolveExternalEngineCli(runtime.officialCliCommand, env, platform);
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
