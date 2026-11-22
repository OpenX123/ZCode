export type {
  ParseTaskTitleDisplayOptions,
  ReferenceIconKind,
  ReferenceIconNode,
  ReferenceIconProps,
  TaskTitleDisplayProps,
  TaskTitleFallbackLabels,
  TaskTitleLookup,
  TaskTitleLookupProviderProps,
  TaskTitleSegment,
  TaskTitleSegmentKind,
} from "./contract.js";
export { REFERENCE_ICON_NODES, REFERENCE_ICON_VIEW_BOX } from "./icons.js";
export { ReferenceIcon } from "./ReferenceIcon.js";
export { getTaskTitleDisplayText, parseTaskTitleDisplay } from "./parseTaskTitle.js";
export { TaskTitleDisplay } from "./TaskTitleDisplay.js";
export { TaskTitleLookupProvider } from "./TaskTitleLookup.js";
