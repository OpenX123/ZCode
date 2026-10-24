import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** 独立 CLI 只导入用户自己的旧模型配置，不恢复官方账号。 */
  readonly standalone?: {
    readonly legacyCliUserConfigFilePath?: string;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths)
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  // 独立工具只信任随包目录与用户配置；旧远端缓存、账号 Overlay 和凭据不参与启动。
  const bundledFile = env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim();
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile ? { zcodeBuiltinFilePath: bundledFile } : {}),
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  let modelSelectionConfigRepository: NodeModelSelectionConfigRepository | undefined;
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
    const repository = modelSelectionConfigRepository;
    return Object.freeze({
      runtime,
      snapshot,
      modelSelectionConfigRepository: repository,
      configuredDefaultModelSelection,
      dispose() {
        repository.dispose();
        runtime.dispose();
      },
    });
  } catch (error) {
    modelSelectionConfigRepository?.dispose();
    runtime.dispose();
    throw error;
  }
}
