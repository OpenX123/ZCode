export const externalEngineProtocolModule = {
  id: "external-engine-protocol",
  requires: [],
  provides: ["external-engine-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
