import type { EngineControlsProps } from "./contract.js";
export const externalEngineControlsExample = {
  engine: "codex",
  onConfigChange: async () => true,
  options: [
    {
      id: "mode",
      name: "Mode",
      currentValue: "read-only",
      options: [{ value: "read-only", name: "Read only" }],
    },
  ],
} satisfies EngineControlsProps;
