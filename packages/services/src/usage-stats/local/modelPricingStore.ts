import { readFile } from "node:fs/promises";
import { z } from "zod";
import { modelPriceSchema, type ModelPrice, type ModelPriceSyncResult } from "@zcode/shared";
import { atomicWriteText } from "../../fs/atomicFileUtils.js";
import { normalizeModelId, type PricingTables } from "./modelPricing.js";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
const SYNC_TIMEOUT_MS = 15_000;
/** 只取与本机来源相关的提供商；靠前者优先（同一模型在多家出现时）。 */
const MODELS_DEV_PROVIDERS = ["anthropic", "openai", "zai", "zhipuai"] as const;

const pricingFileSchema = z.object({
  version: z.literal(1),
  manual: z.record(z.string(), modelPriceSchema),
  synced: z.record(z.string(), modelPriceSchema),
  syncedAt: z.number().nullable(),
});
type PricingFile = z.infer<typeof pricingFileSchema>;

const costNumber = z.number().finite().nonnegative().optional();
const modelsDevSchema = z.record(
  z.string(),
  z
    .object({
      models: z
        .record(
          z.string(),
          z
            .object({
              cost: z
                .object({
                  input: costNumber,
                  output: costNumber,
                  cache_read: costNumber,
                  cache_write: costNumber,
                })
                .passthrough()
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
);

/** 解析 models.dev api.json（单价已是 USD / 百万 token）。Claude 1h 写入 = 2 × input。 */
export function parseModelsDevPrices(raw: unknown): Record<string, ModelPrice> {
  const parsed = modelsDevSchema.safeParse(raw);
  if (!parsed.success) throw new Error("models.dev 返回格式无法识别");
  const prices: Record<string, ModelPrice> = {};
  for (const providerId of MODELS_DEV_PROVIDERS) {
    const models = parsed.data[providerId]?.models ?? {};
    for (const [modelId, model] of Object.entries(models)) {
      const cost = model.cost;
      if (cost?.input === undefined || cost.output === undefined) continue;
      const key = normalizeModelId(modelId);
      if (prices[key]) continue;
      prices[key] = {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache_read ?? 0,
        cacheWrite: cost.cache_write ?? 0,
        ...(providerId === "anthropic" ? { cacheWrite1h: cost.input * 2 } : {}),
      };
    }
  }
  return prices;
}

export interface ModelPricingStoreOptions {
  file: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** 价格覆盖与同步结果的唯一所有者；只有 syncFromModelsDev 会联网（用户点击触发）。 */
export class ModelPricingStore {
  private data: PricingFile | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ModelPricingStoreOptions) {}

  private async load(): Promise<PricingFile> {
    if (this.data) return this.data;
    try {
      const parsed = pricingFileSchema.safeParse(JSON.parse(await readFile(this.options.file, "utf8")));
      this.data = parsed.success ? parsed.data : null;
    } catch {
      this.data = null;
    }
    this.data ??= { version: 1, manual: {}, synced: {}, syncedAt: null };
    return this.data;
  }

  private async persist(): Promise<void> {
    const data = await this.load();
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => atomicWriteText(this.options.file, JSON.stringify(data, null, 2)));
    await this.writeChain;
  }

  async getTables(): Promise<{ tables: PricingTables; syncedAt: number | null }> {
    const data = await this.load();
    return { tables: { manual: data.manual, synced: data.synced }, syncedAt: data.syncedAt };
  }

  async setOverride(modelId: string, price: ModelPrice | null): Promise<void> {
    const data = await this.load();
    const key = normalizeModelId(modelId);
    const manual = { ...data.manual };
    if (price) manual[key] = price;
    else delete manual[key];
    this.data = { ...data, manual };
    await this.persist();
  }

  async syncFromModelsDev(): Promise<ModelPriceSyncResult> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    let raw: unknown;
    try {
      const response = await fetchImpl(MODELS_DEV_API_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
      raw = await response.json();
    } finally {
      clearTimeout(timer);
    }
    const synced = parseModelsDevPrices(raw);
    const syncedAt = (this.options.now ?? Date.now)();
    const data = await this.load();
    this.data = { ...data, synced, syncedAt };
    await this.persist();
    return { syncedAt, modelCount: Object.keys(synced).length };
  }
}
