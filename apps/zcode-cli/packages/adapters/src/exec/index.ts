export { resolveEffectiveBashShellSelection } from "./bash-shell-provider.js";
export {
  applyResolvedShellCommandForTest,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
export type { ResolvedSpawnCommand } from "./execution-command.js";
export type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
export { createNodeExecutionAdapter, NodeExecutionAdapter } from "./node-execution-adapter.js";
export { decodeExecutionOutputBuffer } from "./outputEncoding.js";
export {
  createExternalEngineConfigCatalog,
  createExternalEnginePort,
  createExternalEngineProcessPool,
  type ExternalEngineConfigCatalog,
  type ExternalEngineProcessPool,
  runExternalEngineConnectionTest,
} from "../external-engine/index.js";
