import {
  EXTERNAL_ENGINE_RUNTIMES,
  isExternalSessionEngine,
  resolveSessionEngine,
  type ExternalEngineRuntimeDescriptor,
  type SessionEngine,
} from "./contract.js";

// 示例：会话按引擎分派——zcode 走现有 Agent，外部引擎取运行时描述启动 adapter。
export function describeSessionEngine(config: {
  engine?: SessionEngine;
}): ExternalEngineRuntimeDescriptor | null {
  const engine = resolveSessionEngine(config);
  return isExternalSessionEngine(engine) ? EXTERNAL_ENGINE_RUNTIMES[engine] : null;
}
