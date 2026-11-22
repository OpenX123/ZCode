import { RefreshCcw } from "lucide-react";
import { useState } from "react";
import type { LocalUsagePricingRow, ModelPrice, ModelPriceSyncResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LocalUsageTable } from "@/settings/usage-stats/local/LocalUsageTables.js";
import {
  formatDateTime,
  formatUnitPrice,
  parsePriceInput,
} from "@/settings/usage-stats/local/localUsageFormat.js";

const L = "settings.usageStats.local";
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;
type PriceField = (typeof PRICE_FIELDS)[number];
type Draft = Record<PriceField, string>;

function toDraft(price: ModelPrice | null): Draft {
  const text = (value: number | undefined) => (value === undefined ? "" : String(value));
  return {
    input: text(price?.input),
    output: text(price?.output),
    cacheRead: text(price?.cacheRead),
    cacheWrite: text(price?.cacheWrite),
    cacheWrite1h: text(price?.cacheWrite1h),
  };
}

/** 草稿 → 价格；必填项缺失或非法时返回 null。 */
export function draftToModelPrice(draft: Draft): ModelPrice | null {
  const values = Object.fromEntries(
    PRICE_FIELDS.map((field) => [field, parsePriceInput(draft[field])]),
  ) as Record<PriceField, number | undefined | null>;
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = values;
  if (input == null || output == null || cacheWrite1h === null) return null;
  if (cacheRead === null || cacheWrite === null) return null;
  return {
    input,
    output,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
  };
}

export function LocalUsagePricingTab({
  rows,
  syncedAt,
  onSave,
  onSync,
}: {
  rows: LocalUsagePricingRow[];
  syncedAt: number | null;
  onSave: (modelId: string, price: ModelPrice | null) => Promise<void>;
  onSync: () => Promise<ModelPriceSyncResult>;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `${L}.${id}` }, values);
  const [editing, setEditing] = useState<{ modelId: string; draft: Draft } | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<string | null>, failureId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ tone: "info", text });
    } catch (error) {
      setMessage({
        tone: "error",
        text: t(failureId, { error: error instanceof Error ? error.message : String(error) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!editing) return;
    const price = draftToModelPrice(editing.draft);
    if (!price) {
      setMessage({ tone: "error", text: t("pricing.invalid") });
      return;
    }
    void run(async () => {
      await onSave(editing.modelId, price);
      setEditing(null);
      return null;
    }, "pricing.saveFailed");
  };

  const priceCell = (row: LocalUsagePricingRow, field: PriceField) => {
    if (editing?.modelId === row.modelId) {
      return (
        <Input
          size="sm"
          inputMode="decimal"
          aria-label={`${row.modelId} ${t(`col.${field}`)}`}
          className="ml-auto w-20 text-right tabular-nums"
          value={editing.draft[field]}
          onChange={(event) =>
            setEditing({ ...editing, draft: { ...editing.draft, [field]: event.target.value } })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") setEditing(null);
          }}
        />
      );
    }
    return formatUnitPrice(row.price?.[field]);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-1">
        <div className="min-w-0 text-ui-sm text-foreground-subtle">
          {t("pricing.unit")} ·{" "}
          {syncedAt
            ? t("pricing.syncedAt", { time: formatDateTime(locale, syncedAt) })
            : t("pricing.neverSynced")}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-md bg-background"
          disabled={busy}
          title={t("pricing.syncHint")}
          onClick={() =>
            void run(async () => {
              const result = await onSync();
              return t("pricing.syncDone", { count: String(result.modelCount) });
            }, "pricing.syncFailed")
          }
        >
          <RefreshCcw className="size-3.5" />
          {busy ? t("pricing.syncing") : t("pricing.sync")}
        </Button>
      </div>
      {message ? (
        <div
          role={message.tone === "error" ? "alert" : "status"}
          className={
            message.tone === "error"
              ? "px-3 text-ui-sm text-destructive"
              : "px-3 text-ui-sm text-foreground-subtle"
          }
        >
          {message.text}
        </div>
      ) : null}
      <LocalUsageTable
        rows={rows}
        rowKey={(row) => row.modelId}
        empty={t("pricing.empty")}
        columns={[
          {
            key: "model",
            label: t("col.model"),
            render: (row) => row.modelId,
            className: "font-medium",
          },
          ...PRICE_FIELDS.map((field) => ({
            key: field,
            label: t(`col.${field}`),
            align: "right" as const,
            render: (row: LocalUsagePricingRow) => priceCell(row, field),
          })),
          {
            key: "origin",
            label: t("col.origin"),
            render: (row) => (
              <span className="text-foreground-subtle">
                {row.origin ? t(`pricing.origin.${row.origin}`) : t("unpriced")}
              </span>
            ),
          },
          {
            key: "actions",
            label: "",
            align: "right",
            render: (row) =>
              editing?.modelId === row.modelId ? (
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    {t("pricing.cancel")}
                  </Button>
                  <Button type="button" size="sm" disabled={busy} onClick={save}>
                    {t("pricing.save")}
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end gap-1">
                  {row.origin === "manual" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await onSave(row.modelId, null);
                          return null;
                        }, "pricing.saveFailed")
                      }
                    >
                      {t("pricing.reset")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing({ modelId: row.modelId, draft: toDraft(row.price) })}
                  >
                    {t("pricing.edit")}
                  </Button>
                </div>
              ),
          },
        ]}
      />
    </div>
  );
}
