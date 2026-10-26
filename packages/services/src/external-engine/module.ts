export const externalEngineServiceModule = {
  id: "external-engine-service",
  requires: ["services", "shared", "rpc", "external-engine-protocol"],
  provides: ["external-engine-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
