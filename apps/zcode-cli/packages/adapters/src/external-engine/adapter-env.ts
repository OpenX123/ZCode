import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { ExternalEngineConnectionError } from "@zcode/contracts";
import { atomicWritePrivateTextFile, resolveExternalEngineCli } from "@zcode/shared/node";
import { applyNetworkEgressEnv } from "../network/subprocess-env.js";

const NODE_RUNTIME_DIR = ".node-runtime";
/** Windows node.cmd 通过该变量取得当前运行时路径（见 docs/design/v2/external-agent-engines.md）。 */
export const EXTERNAL_ENGINE_NODE_ENV = "ZCODE_EXTERNAL_ENGINE_NODE";

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * cmd 按控制台代码页（如 936）而非 UTF-8 解码批处理文件，用户名含中文时内嵌的可执行路径会被
 * 解错；路径改经 Unicode 环境变量传入，批处理内容保持纯 ASCII 且不受路径中的 % 影响。
 */
export function windowsNodeShimContent(): string {
  return `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%${EXTERNAL_ENGINE_NODE_ENV}%" %*\r\n`;
}

/**
 * 桌面可能只有 Electron Node 模式：npm 的 env node 入口与 adapter 自带的 codex.js（经 cross-spawn
 * 解析 shebang）在 PATH 缺 node 时以 127 或 ENOENT 退出。只为 ACP 子进程补充指向当前运行时的入口：
 * POSIX 为符号链接 node，Windows 为 node.cmd（Windows 符号链接需要额外权限，Electron 也会按链接
 * 路径寻找资源）。不修改系统 PATH 或用户官方 CLI。
 */
export async function ensureNodeRuntimeOnPath(
  root: string,
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (await resolveExternalEngineCli("node", env, platform)) return;
  const runtimeKey = createHash("sha256").update(executable).digest("hex").slice(0, 16);
  const bin = join(root, NODE_RUNTIME_DIR, runtimeKey);
  await mkdir(bin, { recursive: true });
  if (platform === "win32") {
    const shim = join(bin, "node.cmd");
    const content = windowsNodeShimContent();
    const current = await readFile(shim, "utf8").catch(() => undefined);
    if (current !== content) await atomicWritePrivateTextFile(shim, content);
    // 只由 adapter 写入，覆盖继承值，避免宿主环境把补位入口指向其他程序。
    for (const key of Object.keys(env))
      if (key.toUpperCase() === EXTERNAL_ENGINE_NODE_ENV) delete env[key];
    env[EXTERNAL_ENGINE_NODE_ENV] = executable;
  } else {
    const node = join(bin, "node");
    try {
      await symlink(executable, node);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await realpath(node)) !== (await realpath(executable)))
        throw new ExternalEngineConnectionError({ code: "not_ready" });
    }
  }
  const key = pathKey(env);
  env[key] = [bin, env[key]].filter(Boolean).join(platform === "win32" ? ";" : delimiter);
}

/**
 * 运行时启动时已把用户的代理/证书变量封存进 ZCODE_TOOL_ENV_PASSTHROUGH_JSON；adapter 与官方 CLI
 * 沿用工具子进程的既有恢复规则：恢复用户原值，YCode 显式代理、No Proxy 或 CA 覆盖对应变量。
 */
export function withNetworkEgressEnv(
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value;
  return applyNetworkEgressEnv(defined, { sourceEnv, platform });
}
