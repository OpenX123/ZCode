import { resolve } from "node:path";
import { createConfig, resolvePath, type ConfigResult } from "@zcode/adapters/config";
import { createNodeCustomCommandAdapter } from "@zcode/adapters/commands";
import type {
  CustomCommandContent,
  CustomCommandDiagnostic,
  CustomCommandLoadOutcome,
  Logger,
  PluginLoadOutcome,
} from "@zcode/contracts";
import { getCliStorageRoot, getPluginStorageRoot } from "./app/paths.js";
import { computePluginResolutionRevision } from "./plugin-resolution-revision.js";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

// 每个 workspace 一项；一个 CLI 进程通常只服务一个 workspace，上限只防异常输入无界增长。
const PLUGIN_COMMAND_ROOTS_MEMO_LIMIT = 16;
const pluginCommandRootsMemo = new Map<
  string,
  { commandRoots: PluginLoadOutcome["commandRoots"]; revision: string }
>();

export interface ListZCodeCustomCommandsOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
  additionalDirectories?: readonly string[];
}

export interface InspectZCodeCustomCommandOptions extends ListZCodeCustomCommandsOptions {
  name: string;
}

export interface ZCodeCustomCommandInspection {
  command: CustomCommandContent;
  diagnostics: CustomCommandDiagnostic[];
}

export async function listZCodeCustomCommands(
  options: ListZCodeCustomCommandsOptions = {},
): Promise<CustomCommandLoadOutcome> {
  const discovery = await createCustomCommandDiscovery(options);
  return await discovery.adapter.discoverCommands({
    workingDirectory: discovery.workingDirectory,
  });
}

export async function inspectZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<ZCodeCustomCommandInspection> {
  const discovery = await createCustomCommandDiscovery(options);
  const workingDirectory = discovery.workingDirectory;
  const adapter = discovery.adapter;
  const outcome = await adapter.discoverCommands({ workingDirectory });
  const normalizedName = normalizeCommandName(options.name);
  if (!outcome.commands.some((command) => command.name === normalizedName)) {
    throw new Error(`Custom command not found: ${options.name}`);
  }

  return {
    command: await adapter.loadCommand({
      name: normalizedName,
      workingDirectory,
    }),
    diagnostics: outcome.diagnostics,
  };
}

export async function loadZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<CustomCommandContent> {
  const discovery = await createCustomCommandDiscovery(options);
  return await discovery.adapter.loadCommand({
    name: normalizeCommandName(options.name),
    workingDirectory: discovery.workingDirectory,
  });
}

async function createCustomCommandDiscovery(options: ListZCodeCustomCommandsOptions) {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });
  return {
    adapter: createNodeCustomCommandAdapter({
      extraResolvedRoots: await resolvePluginCommandRoots(options, configResult, workingDirectory),
      disabledPaths: collectDisabledPaths(configResult.config.commandOverrides),
      homeDirectory: options.homeDirectory,
      additionalDirectories: options.additionalDirectories,
    }),
    workingDirectory,
  };
}

/**
 * 修复原因：工作区展示（`workspace/readPresentation`）与会话快照的 `/` 目录每次都同步完整解析
 * 插件（seed 内置插件 + 遍历全部插件清单），只为取命令根目录（1.0.5 生产日志
 * readWorkspacePresentation p50 2.0s / p90 18s，含排队）。这里按（workspace、插件修订）在进程内复用
 * 命令根目录；插件修订覆盖安装、卸载、更新、启停与恢复内置，命令文件本身仍每次实时枚举。
 */
async function resolvePluginCommandRoots(
  options: ListZCodeCustomCommandsOptions,
  configResult: ConfigResult,
  workingDirectory: string,
): Promise<PluginLoadOutcome["commandRoots"]> {
  const pluginStorageRoot = getPluginStorageRoot(
    getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
  );
  const revision = await computePluginResolutionRevision({ configResult, pluginStorageRoot });
  const memoKey = `${workingDirectory}\0${pluginStorageRoot}`;
  const cached = pluginCommandRootsMemo.get(memoKey);
  if (cached?.revision === revision) return [...cached.commandRoots];
  const pluginOutcome = resolveZCodePlugins({
    configResult,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });
  pluginCommandRootsMemo.delete(memoKey);
  pluginCommandRootsMemo.set(memoKey, { commandRoots: pluginOutcome.commandRoots, revision });
  while (pluginCommandRootsMemo.size > PLUGIN_COMMAND_ROOTS_MEMO_LIMIT) {
    const oldest = pluginCommandRootsMemo.keys().next().value;
    if (oldest === undefined) break;
    pluginCommandRootsMemo.delete(oldest);
  }
  return [...pluginOutcome.commandRoots];
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}
