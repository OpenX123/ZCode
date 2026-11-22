import { useId, useRef, useState } from "react";
import { ChevronRightIcon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  classifyErrorExplanation,
  errorExplanationHintId,
  errorExplanationTitleId,
  type ErrorExplanationKind,
} from "@/error-explanations/index.js";

export interface DiagnosticsRow {
  label: string;
  value: string;
}

export function diagnosticsRowsToText(rows: readonly DiagnosticsRow[]): string {
  return rows.map((row) => (row.label ? `${row.label}: ${row.value}` : row.value)).join("\n");
}

async function copyDiagnostics(
  text: string,
  formatMessage: (id: string, values?: Record<string, string>) => string,
) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast(formatMessage("chat.error.copyFailed", { error: "clipboard-unavailable" }));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(formatMessage("chat.error.copyFull.copied"));
  } catch (error) {
    toast(
      formatMessage("chat.error.copyFailed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * 等宽灰底诊断卡（Codex 式）：键值行 + 右上角「复制全部」。
 * 只接收边界已脱敏的字段；复制内容即卡片可见内容（可附加上下文行）。
 */
export function DiagnosticsCard({
  id,
  rows,
  copyText,
  copyLabel: copyLabelOverride,
}: {
  id?: string;
  rows: readonly DiagnosticsRow[];
  copyText?: string;
  copyLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const copyLabel = copyLabelOverride ?? intl.formatMessage({ id: "chat.error.copyAll" });
  return (
    <div
      id={id}
      data-testid="error-diagnostics-card"
      className="relative mt-1.5 min-w-0 rounded-lg border border-border/60 bg-foreground/[0.04] py-2 pr-24 pl-3 font-mono text-ui-xs text-foreground-subtle"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute top-1 right-1 h-6 gap-1 px-1.5 font-sans text-ui-xs text-foreground-subtle"
        aria-label={copyLabel}
        data-testid="error-diagnostics-copy"
        onClick={() =>
          void copyDiagnostics(copyText ?? diagnosticsRowsToText(rows), (messageId, values) =>
            intl.formatMessage({ id: messageId }, values),
          )
        }
      >
        <CopyIcon aria-hidden="true" className="size-3" />
        {copyLabel}
      </Button>
      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {rows.map((row, index) =>
          row.label ? (
            <div key={`${row.label}-${index}`} className="contents">
              <dt className="whitespace-nowrap text-foreground-subtle/80">{row.label}</dt>
              <dd className="m-0 min-w-0 select-text whitespace-pre-wrap break-all text-foreground">
                {row.value}
              </dd>
            </div>
          ) : (
            <dd
              key={`raw-${index}`}
              className="col-span-2 m-0 min-w-0 select-text whitespace-pre-wrap break-all text-foreground"
            >
              {row.value}
            </dd>
          ),
        )}
      </dl>
    </div>
  );
}

/** 「详情 ›」展开开关；展开态由调用方持有，卡片与开关通过 aria-controls 关联。 */
function DetailsToggle({
  expanded,
  controls,
  onToggle,
  label,
}: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  label?: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      data-testid="error-details-toggle"
      onClick={onToggle}
      className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-ui-sm text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:bg-hover focus-visible:outline-none"
    >
      {label ?? intl.formatMessage({ id: "chat.error.details" })}
      <ChevronRightIcon
        aria-hidden="true"
        className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")}
      />
    </button>
  );
}

/** 单段原文诊断（引擎连接失败等）：沿用同一开关与诊断卡外观。 */
export function ErrorDiagnostics({
  text,
  label,
  copyLabel,
}: {
  text: string;
  label?: string;
  copyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const cardId = useId();
  return (
    <div className="mt-1 min-w-0 text-ui-sm">
      <DetailsToggle
        expanded={expanded}
        controls={cardId}
        label={label}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded ? (
        <DiagnosticsCard id={cardId} rows={[{ label: "", value: text }]} copyLabel={copyLabel} />
      ) : null}
    </div>
  );
}

/** 行内错误行可展示的诊断；全部字段已在 ACP adapter / V4 投影边界脱敏。 */
export interface FailureDiagnosticsFields {
  /** 稳定错误码（turnHeader.failure.code）。 */
  code?: string;
  /** 错误源（provider / runtime / tool / network），仅用于人话归类。 */
  source?: string;
  message?: string;
  httpStatus?: number;
  /** 仅 scheme + host + path。 */
  url?: string;
  requestId?: string;
  traceId?: string;
}

export type TurnFailureRowProps =
  | {
      kind: "retry";
      attempt: number;
      /** 原生展示的重试上限；0 表示未知。 */
      maxRetries: number;
      fields: FailureDiagnosticsFields;
    }
  | {
      kind: "failure";
      summary: string;
      fields: FailureDiagnosticsFields;
      /**
       * 摘要已按稳定错误码本地化时传 false，不再用归类说明覆盖；缺省 true。
       */
      explain?: boolean;
      /** 仅失败轮没有助手输出和工具执行时提供；点击才发送，不自动重发。 */
      onResend?: () => Promise<void>;
    };

function useDiagnosticsRows(
  fields: FailureDiagnosticsFields,
  extra: { hint?: string; raw?: string },
): DiagnosticsRow[] {
  const { intl } = useZCodeIntl();
  const label = (id: string) => intl.formatMessage({ id });
  const rows: DiagnosticsRow[] = [];
  if (extra.hint) rows.push({ label: label("chat.error.field.hint"), value: extra.hint });
  if (fields.code) rows.push({ label: label("chat.error.field.code"), value: fields.code });
  if (fields.httpStatus !== undefined)
    rows.push({ label: label("chat.error.field.httpStatus"), value: String(fields.httpStatus) });
  if (fields.requestId)
    rows.push({ label: label("chat.error.field.requestId"), value: fields.requestId });
  if (fields.traceId) rows.push({ label: "Trace ID", value: fields.traceId });
  if (fields.url) rows.push({ label: "URL", value: fields.url });
  const raw = fields.message ?? extra.raw;
  if (raw) rows.push({ label: label("chat.error.field.raw"), value: raw });
  return rows;
}

/** 诊断行里是否有比「建议」更多的事实；只有建议时不显示详情开关。 */
function hasFacts(rows: readonly DiagnosticsRow[], hint: string | undefined): boolean {
  return rows.length > (hint ? 1 : 0);
}

/**
 * 三个引擎共用的行内错误行（docs/desktop/native-plan-errors-spec.md「行内错误行与横幅」）：
 * 一行 ⚠ + 人话 + 「重试」+ 「详情 ›」；展开为等宽灰底诊断卡，含错误码、HTTP 状态、
 * 请求/Trace ID、URL 与原始报错，右上角复制全部。重试中显示“正在重新连接 n/m”。
 */
export function TurnFailureRow(props: TurnFailureRowProps) {
  const { intl, locale } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const [resending, setResending] = useState(false);
  const flight = useRef(false);
  const cardId = useId();
  const explanation: ErrorExplanationKind | undefined =
    props.kind === "failure" && props.explain !== false
      ? classifyErrorExplanation({ ...props.fields, summary: props.summary })
      : props.kind === "retry"
        ? classifyErrorExplanation(props.fields)
        : undefined;
  const hint = explanation
    ? intl.formatMessage({ id: errorExplanationHintId(explanation) })
    : undefined;
  const headline =
    props.kind === "failure"
      ? explanation
        ? intl.formatMessage({ id: errorExplanationTitleId(explanation) })
        : props.summary
      : undefined;
  const rows = useDiagnosticsRows(props.fields, {
    hint,
    // 一行显示会截断长摘要，且人话可能替换摘要：上游原文缺失时用摘要作为原始报错，信息不丢失。
    raw: props.kind === "failure" ? props.summary : undefined,
  });
  const showDetails = hasFacts(rows, hint);
  const copyText = [headline, diagnosticsRowsToText(rows)].filter(Boolean).join("\n");
  const toggle = showDetails ? (
    <DetailsToggle
      expanded={expanded}
      controls={cardId}
      onToggle={() => setExpanded((value) => !value)}
    />
  ) : null;
  const card =
    showDetails && expanded ? (
      <DiagnosticsCard id={cardId} rows={rows} copyText={copyText} />
    ) : null;
  if (props.kind === "retry") {
    const formatter = new Intl.NumberFormat(locale);
    const label = intl.formatMessage(
      { id: props.maxRetries > 0 ? "chat.apiRetryStatus" : "chat.apiRetryStatusUnknown" },
      {
        attempt: formatter.format(props.attempt),
        maxRetries: formatter.format(props.maxRetries),
      },
    );
    return (
      <div
        data-testid="turn-failure-row"
        data-variant="retry"
        role="status"
        className="min-w-0 px-1 text-ui-base"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          {/* 重试是次级运行状态：沿用 ToolCall/Thinking 的扫光节奏，峰值降到 secondary 文本色。 */}
          <span className="animated-gradient-text animated-gradient-text-subtle font-medium">
            {label}
          </span>
          {toggle}
        </div>
        {card}
      </div>
    );
  }
  const { onResend } = props;
  const resend = onResend
    ? async () => {
        // 同一失败轮只允许一次在途重发；用户点击才发送，失败保留按钮。
        if (flight.current) return;
        flight.current = true;
        setResending(true);
        try {
          await onResend();
        } catch (error) {
          logger.warn("[turn-failure-row] 重新发送失败", { error });
          toast(intl.formatMessage({ id: "chat.failureRow.resendFailed" }));
        } finally {
          flight.current = false;
          setResending(false);
        }
      }
    : undefined;
  return (
    <div
      data-testid="turn-failure-row"
      data-variant="failure"
      data-explanation={explanation}
      role="alert"
      className="min-w-0 px-1 text-ui-base"
    >
      <div className="flex min-w-0 items-center gap-2">
        <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
        <p className="m-0 min-w-0 flex-1 select-text truncate text-foreground" title={headline}>
          {headline}
        </p>
        {resend ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1.5 text-ui-sm"
            disabled={resending}
            onClick={() => void resend()}
            data-testid="turn-failure-resend"
          >
            {intl.formatMessage({ id: "chat.failureRow.resend" })}
          </Button>
        ) : null}
        {toggle}
      </div>
      {card}
    </div>
  );
}
