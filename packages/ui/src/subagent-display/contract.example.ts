import type { SubagentFaceProps, SubagentSessionHeaderModel } from "./contract.js";

export const subagentFaceExample = {
  avatarIndex: 1,
  name: "Explore project structure",
  subagentType: "Explore",
  status: "running",
  size: 20,
} satisfies SubagentFaceProps;

export const subagentSessionHeaderExample = {
  avatarIndex: 1,
  variant: "antenna",
  status: "running",
  startedAt: 1_700_000_000_000,
  stopWorkId: "work-1",
} satisfies SubagentSessionHeaderModel;
