import type { RegularTurnLoopState } from "../runtime/methods/turn-loop-state.js";
export type ExternalTurnLoopState = Pick<
  RegularTurnLoopState,
  | "events"
  | "modelResponse"
  | "tokenCount"
  | "toolCallCount"
  | "historyRoundCount"
  | "turnMachine"
  | "backgroundSubagentResultConsumed"
  | "workflowResultConsumed"
  | "turnRequestState"
  | "stableProductStartMessageId"
  | "stableBoundaryAssistantMessageId"
> & { model?: undefined };
