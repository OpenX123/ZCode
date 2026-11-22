import type { ModelPrice, ModelPriceOrigin } from "@zcode/shared";

/**
 * 内置 API 价格（USD / 百万 token）。仅用于“按 API 价格估算”，不是账单。
 * cacheWrite = 5 分钟缓存写入；cacheWrite1h 仅 Claude。表外模型为未定价。
 * key 必须是 normalizeModelId 之后的形式。
 */
export const BUILTIN_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  "claude-opus-4.1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  "claude-opus-4.5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-3.7-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-3.5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  "claude-3.5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 },
  // OpenAI（Codex）：缓存写入不另计费
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  "gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  // Z.AI GLM（ZCode 原生常用）
  "glm-4.5": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  "glm-4.5-air": { input: 0.2, output: 1.1, cacheRead: 0.03, cacheWrite: 0 },
  "glm-4.6": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  "glm-4.7": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
};

/**
 * 模型 ID 归一化：同一模型在不同来源（Claude 日志、Bedrock/Vertex、models.dev、ZCode provider）
 * 的写法收敛到同一个 key，用于价格查找与“按模型”分组。
 */
export function normalizeModelId(raw: string | null | undefined): string {
  let id = (raw ?? "").trim().toLowerCase();
  if (!id) return "unknown";
  // provider/model、bedrock 区域前缀 us.anthropic.xxx / anthropic.xxx
  if (id.includes("/")) id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./u, "");
  // [1m] 等上下文标记、:thinking 等变体后缀
  id = id.replace(/\[[^\]]*\]/gu, "").replace(/:[a-z-]+$/u, "");
  // bedrock 版本后缀与日期后缀
  id = id.replace(/-v\d+(?::\d+)?$/u, "");
  id = id.replace(/[@-](?:20\d{6}|\d{4}-\d{2}-\d{2})$/u, "");
  id = id.replace(/-latest$/u, "");
  // claude-opus-4-5 → claude-opus-4.5；claude-3-5-sonnet → claude-3.5-sonnet
  id = id.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d)(?=$|-)/u, "$1.$2");
  id = id.replace(/^(claude-\d+)-(\d)(?=-)/u, "$1.$2");
  return id.trim() || "unknown";
}

/** 精确匹配 → 以 `-` 为边界的最长前缀匹配（gpt-5.1-codex-max → gpt-5.1-codex）。 */
export function findPriceKey(
  modelId: string,
  table: Readonly<Record<string, unknown>>,
): string | null {
  if (Object.hasOwn(table, modelId)) return modelId;
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (modelId.startsWith(`${key}-`) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

export interface PricingTables {
  manual: Readonly<Record<string, ModelPrice>>;
  synced: Readonly<Record<string, ModelPrice>>;
  builtin?: Readonly<Record<string, ModelPrice>>;
}

export interface ResolvedPrice {
  price: ModelPrice;
  origin: ModelPriceOrigin;
}

/** 优先级：手动覆盖 > 已同步 > 内置；每层都先精确再前缀。 */
export function resolveModelPrice(modelId: string, tables: PricingTables): ResolvedPrice | null {
  const layers: Array<[ModelPriceOrigin, Readonly<Record<string, ModelPrice>>]> = [
    ["manual", tables.manual],
    ["synced", tables.synced],
    ["builtin", tables.builtin ?? BUILTIN_MODEL_PRICES],
  ];
  for (const [origin, table] of layers) {
    const key = findPriceKey(modelId, table);
    const price = key ? table[key] : undefined;
    if (price) return { price, origin };
  }
  return null;
}

export interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export function computeCostUsd(tokens: CostTokens, price: ModelPrice): number {
  const cacheWrite1h = price.cacheWrite1h ?? price.cacheWrite;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheWrite5mTokens * price.cacheWrite +
      tokens.cacheWrite1hTokens * cacheWrite1h) /
    1_000_000
  );
}
