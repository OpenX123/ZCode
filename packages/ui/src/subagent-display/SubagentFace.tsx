import { cn } from "@/components/lib/utils.js";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import type { SubagentFaceProps } from "./contract.js";
import { faceStatusOf, resolveSubagentFaceVariant } from "./model.js";

/**
 * 子智能体头像：同一张瓦片脸，颜色 = 实例序号，轮廓 = 类型，表情 = 状态。
 * 默认静止；只有调用方明确 `animated`（运行中的详情头部）才调度空闲动作，
 * 且 `startFaceMotion` 在减少动态效果、页面隐藏或离开视口时自行停止。
 */
export function SubagentFace({
  animated = false,
  avatarIndex,
  className,
  name,
  ringed = false,
  size,
  status,
  subagentType,
}: SubagentFaceProps) {
  return (
    <WorkflowAgentFace
      avatarIndex={avatarIndex}
      className={cn("shrink-0", className)}
      name={name}
      ringed={ringed}
      size={size}
      status={faceStatusOf(status)}
      still={!animated}
      variant={resolveSubagentFaceVariant(subagentType)}
    />
  );
}

export const SUBAGENT_FACE_STACK_LIMIT = 3;

/** 重叠头像串（最多 3 个，20px，后一个压前一个 6px）；分隔环取所在表面色。 */
export function SubagentFaceStack({
  faces,
}: {
  faces: readonly Omit<SubagentFaceProps, "size" | "ringed" | "animated">[];
}) {
  const visible = faces.slice(0, SUBAGENT_FACE_STACK_LIMIT);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center"
      data-face-count={visible.length}
    >
      {visible.map((face, position) => (
        <SubagentFace
          key={`${face.avatarIndex ?? face.name}:${position}`}
          {...face}
          className={cn(position > 0 && "-ml-1.5")}
          ringed
          size={20}
        />
      ))}
    </span>
  );
}
