import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import {
  engineCommandSchema,
  engineConfigOptionSchema,
  engineConfigStateSchema,
  engineConnectionFailureSchema,
  sessionEngineSchema,
} from "../external-engine/contract.js";

// ── config──
export const sessionConfigStateSchema = z.object({
  /** Session 接受并持久化的稀疏选择意图；provider/model/thought 仅为 UI effective 投影。 */
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // 思考档位是当前模型的能力，不是 workspace/UI 偏好。
  // default 仅用于兼容旧快照；新 agent 必须从 runtime 投影实际集合。
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // additive（冻结面演进，同 meta 的裁决口径）：agent 协作模式（core CollaborationMode）。
  // 必须带 default 才不破坏旧快照/旧发送端的解析；投影经 SessionModeChanged 事件更新。
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /** 明确审批结果；草稿按 interactionId 消费一次，普通 mode 更新不重置它。 */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /** 最近工具转换的关联，供草稿定向同步；不新增可见历史事件。 */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
  // additive：会话引擎，创建后不可变。缺省（含旧快照）视为 zcode，读取统一经
  // resolveSessionEngine；不用 default，避免旧快照往返时被补写字段。
  engine: sessionEngineSchema.optional(),
  // 外部引擎会话的可选配置（mode / model / effort 等）；zcode 会话不下发。
  engineConfigOptions: z.array(engineConfigOptionSchema).optional(),
  engineConfigState: engineConfigStateSchema.optional(),
  engineConfigError: engineConnectionFailureSchema.optional(),
  /** 外部引擎可用命令，按会话投影，不混入 workspace 内置命令。 */
  engineCommands: z.array(engineCommandSchema).optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
