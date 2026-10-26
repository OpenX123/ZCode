export const externalEngineAdapterModule = {
  id: "cli-external-engine-adapter",
  layer: "adapters",
  provides: ["createExternalEnginePort"],
} as const;
