import type {
  SubagentActivityButtonProps,
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

/** 常驻入口直接消费父 manifest，全部结束时仍可查看目录。 */
export const subagentActivityExample = {
  subagents: { revision: 1, childSessionIds: ["child-a"], running: [], endedTotal: 1 },
  onOpen: () => {},
} satisfies SubagentActivityButtonProps;
