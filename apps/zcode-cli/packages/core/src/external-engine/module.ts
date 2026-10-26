export const externalEngineRuntimeModule = {
  id: "cli-external-engine-runtime",
  layer: "app",
  provides: ["runExternalEngineTurn", "publishExternalEngineConfig"],
} as const;
