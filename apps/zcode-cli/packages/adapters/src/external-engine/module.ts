export const externalEngineAdapterModule = {
  id: "cli-external-engine-adapter",
  layer: "adapters",
  provides: ["createExternalEnginePort", "createExternalEngineProcessPool"],
} as const;
