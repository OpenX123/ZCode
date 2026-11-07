import { useEffect, useRef, type CSSProperties } from "react";
import {
  BASE_EXPRESSION,
  faceState,
  startFaceMotion,
} from "@/components/workflow-timeline/workflow-face-motion.js";
export { faceState } from "@/components/workflow-timeline/workflow-face-motion.js";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/**
 * 瓦片脸：应用图标的圆角方块去掉 Z、
 * 加上两只眼。子代理的头像就是它——药丸、名册格、侧栏折叠头像串共用这一张脸。
 *
 * 身份是机身色：九个固定 HEX 颜色按 `avatarIndex` 取，第十个起循环；没有编号退回名字散列。
 * 状态定义基础表情，独立随机动作仅更新 SVG 属性。
 */
export const FACE_COLORS = [
  "#54B9A6",
  "#F19D38",
  "#6464EF",
  "#885CF5",
  "#3C82F6",
  "#ED712E",
  "#EB4699",
  "#5BC67A",
  "#EA4045",
] as const;

/** 名字散列选色（31 进制取模 360 后映射到九色板）；只在没有 `avatarIndex` 时兜底。 */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return FACE_COLORS[hash % FACE_COLORS.length]!;
}

/** 代理的颜色：编号优先（九色环循环），缺席时退回名字散列。药丸悬停描边与脸共用它。 */
export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return avatarColor(name);
  return FACE_COLORS[
    ((avatarIndex % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length
  ]!;
}

const EXPRESSIONS = ["pill", "happy", "sleepy", "focused", "sad", "confused"] as const;

/**
 * 轮廓变体：按子智能体类型区分种类（docs/desktop/multi-agent-display-spec.md「头像」）。
 * 颜色仍只表示实例序号；变体只改几何，16px 下靠轮廓可辨。workflow 药丸固定 `base`。
 */
export const AGENT_FACE_VARIANTS = [
  "base",
  "antenna",
  "visor",
  "glasses",
  "crest",
  "ears",
] as const;
export type AgentFaceVariant = (typeof AGENT_FACE_VARIANTS)[number];
/** 固定像素尺寸；缺席时沿用 className 与 `.wf-face` 的 20px 下限（workflow 表面）。 */
export type AgentFaceSize = 16 | 20 | 24;

/** 顶部有附件（天线、圆耳、锯齿冠）的变体把机身下移，眼睛随机身中心下移同样距离。 */
const EYES_OFFSET: Record<AgentFaceVariant, number> = {
  base: 0,
  antenna: 2.5,
  visor: 0,
  glasses: 0,
  crest: 2,
  ears: 2,
};

/** 轮廓几何（机身色）；分隔环复用同一组形状，所以环始终贴合轮廓。 */
function silhouette(variant: AgentFaceVariant) {
  switch (variant) {
    case "antenna":
      return (
        <>
          <rect y={5} height={15} rx={6} width={20} />
          <rect x={8.9} y={2} width={2.2} height={4} rx={1.1} />
          <circle cx={10} cy={2.4} r={2.4} />
        </>
      );
    case "ears":
      return (
        <>
          <circle cx={4.6} cy={4.6} r={3.6} />
          <circle cx={15.4} cy={4.6} r={3.6} />
          <rect y={4} height={16} rx={6} width={20} />
        </>
      );
    case "crest":
      return (
        <>
          <path d="M2.3 5.8 L5 0.3 L7.5 3 L10 0.3 L12.5 3 L15 0.3 L17.7 5.8 Z" />
          <rect y={4} height={16} rx={6} width={20} />
        </>
      );
    default:
      return <rect height={20} rx={7} width={20} />;
  }
}

// 眼镜随视线平移（放在眼睛组内、眨眼层外），所以眨眼不压扁镜框、扫视时镜框跟着走。
function GlassesFrames() {
  return (
    <g data-face-accessory="glasses" fill="none" stroke="var(--wf-face-eye)" strokeWidth={1.3}>
      <rect x={5.4} y={4.6} width={7.2} height={8.8} rx={3.2} />
      <rect x={11.4} y={4.6} width={7.2} height={8.8} rx={3.2} />
    </g>
  );
}

// 直接在 20 格内绘制参考眼型；共享左右起点，换脸时保持底部和视线位置。
function Eyes({ glasses = false }: { glasses?: boolean }) {
  return (
    <g className="wf-face-eyes">
      <g className="wf-face-bounce">
        <g className="wf-face-lids">
          <g data-eye-expression="dots" fill="var(--wf-face-eye)">
            {[5, 10, 15].map((cx) => (
              <circle key={cx} cx={cx} cy={10} r={1.5} />
            ))}
          </g>
          {EXPRESSIONS.map((expression) => (
            <g key={expression} data-eye-expression={expression} fill="var(--wf-face-eye)">
              {[7, 13].map((x, i) => {
                if (expression === "pill" || expression === "confused") {
                  const short = expression === "confused" && i === 1;
                  return (
                    <rect key={x} x={x} y={short ? 8 : 6} width={4} height={short ? 4 : 6} rx={2} />
                  );
                }
                const paths = {
                  happy: "M0 11 V8 A2 2 0 0 1 4 8 V11 Z",
                  sleepy:
                    i === 0 ? "M0 8 L4 7 V9 A2 2 0 0 1 0 9 Z" : "M0 7 L4 8 V9 A2 2 0 0 1 0 9 Z",
                  focused:
                    i === 0 ? "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z" : "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z",
                  sad:
                    i === 0 ? "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z" : "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z",
                };
                return <path key={x} transform={`translate(${x} 0)`} d={paths[expression]} />;
              })}
            </g>
          ))}
        </g>
        {/* 闭眼单独画横胶囊，避免纵向缩放把端部圆角压成细线。 */}
        <g className="wf-face-closed" fill="var(--wf-face-eye)">
          {[7, 13].map((x) => (
            <rect key={x} x={x} y={8} width={4} height={2} rx={1} />
          ))}
        </g>
        {glasses ? <GlassesFrames /> : null}
      </g>
    </g>
  );
}

export function WorkflowAgentFace({
  avatarIndex,
  className,
  name,
  ringed = false,
  size,
  status,
  still = false,
  variant = "base",
}: {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StepRunStatus | undefined;
  /** 轮廓变体；workflow 表面不传，保持 `base`。 */
  variant?: AgentFaceVariant;
  /** 固定像素尺寸（对话多智能体表面）；缺席时由 className 决定且不小于 20px。 */
  size?: AgentFaceSize;
  /** 静止：只显示当前表情，不调度空闲动作（胶囊、面板行、目录等常驻表面）。 */
  still?: boolean;
  /** 头像串：在轮廓外画一圈宿主表面色（`--wf-face-ring`），重叠时彼此分开。 */
  ringed?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const state = faceState(status);
  useEffect(() => {
    if (still || !ref.current) return;
    return startFaceMotion(ref.current, state);
  }, [state, still]);
  const style = { "--wf-face-body": agentColor(avatarIndex, name) } as CSSProperties;
  const eyesOffset = EYES_OFFSET[variant];
  return (
    <svg
      aria-hidden
      className={cn("wf-face overflow-visible", className)}
      data-face-state={state}
      data-face-variant={variant}
      data-face-size={size}
      data-expression={BASE_EXPRESSION[state]}
      data-motion="idle"
      data-subagent-avatar
      ref={ref}
      style={style}
      viewBox="0 0 20 20"
    >
      {/* 环色由宿主表面经继承变量给出（胶囊悬停时跟着换底色），缺省按浮层底色。 */}
      {ringed ? (
        <g
          className="wf-face-ring"
          fill="var(--wf-face-ring, var(--color-popover))"
          stroke="var(--wf-face-ring, var(--color-popover))"
          strokeLinejoin="round"
          strokeWidth={3}
        >
          {silhouette(variant)}
        </g>
      ) : null}
      {variant === "base" ? (
        // base 仍是单个 rx=7 机身矩形：workflow 表面与其 E2E 依赖这一结构。
        <rect className="wf-face-body" fill="var(--wf-face-body)" height={20} rx={7} width={20} />
      ) : (
        <g className="wf-face-body" fill="var(--wf-face-body)">
          {silhouette(variant)}
        </g>
      )}
      {variant === "visor" ? (
        <rect
          data-face-accessory="visor"
          x={1.5}
          y={4.5}
          width={17}
          height={9}
          rx={4.5}
          fill="#000"
          fillOpacity={0.3}
        />
      ) : null}
      {eyesOffset === 0 ? (
        <Eyes glasses={variant === "glasses"} />
      ) : (
        <g transform={`translate(0 ${eyesOffset})`}>
          <Eyes glasses={variant === "glasses"} />
        </g>
      )}
    </svg>
  );
}
