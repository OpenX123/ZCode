import type {
  SubagentFaceProps,
  SubagentSessionHeaderModel,
  SubagentWorkLiveIndex,
} from "./contract.js";

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
  model: "gpt-6.1-sol",
  effort: "high",
} satisfies SubagentSessionHeaderModel;

/** 工作卡 live 索引：child-b 等待确认且可停；child-a 不在 running[]、无可停 work。 */
export const subagentWorkLiveIndexExample: SubagentWorkLiveIndex = new Map([
  ["child-b", { liveStatus: "waiting", cancellableWorkId: "work-b" }],
]);
