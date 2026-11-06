import { useRef, useState } from "react";
import { CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { Snippet, SnippetCopyButton } from "./snippet.js";

/** 只接收边界已脱敏的诊断，复用现有剪贴板组件。 */
export function ErrorDiagnostics({
  text,
  label,
  copyLabel,
}: {
  text: string;
  label: string;
  copyLabel: string;
}) {
  return (
    <details className="mt-1 min-w-0 text-ui-sm text-foreground-subtle">
      <summary className="cursor-pointer select-none">{label}</summary>
      <div className="mt-1 flex min-w-0 items-start gap-2">
        <pre className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all font-mono text-ui-xs">
          {text}
        </pre>
        <Snippet code={text} className="size-7 shrink-0 border-0 bg-transparent">
          <SnippetCopyButton aria-label={copyLabel} title={copyLabel} />
        </Snippet>
      </div>
    </details>
  );
}

/** 行内错误行可展示的诊断；全部字段已在 ACP adapter / V4 投影边界脱敏。 */
export interface FailureDiagnosticsFields {
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
      /** 仅失败轮没有助手输出和工具执行时提供；点击才发送，不自动重发。 */
      onResend?: () => Promise<void>;
    };

function useDiagnosticsText(fields: FailureDiagnosticsFields): string {
  const { intl } = useZCodeIntl();
  return [
    fields.message
      ? `${intl.formatMessage({ id: "chat.failureRow.upstreamMessage" })}: ${fields.message}`
      : "",
    fields.httpStatus !== undefined
      ? `${intl.formatMessage({ id: "chat.failureRow.httpStatus" })}: ${fields.httpStatus}`
      : "",
    fields.url ? `URL: ${fields.url}` : "",
    fields.requestId
      ? `${intl.formatMessage({ id: "chat.failureRow.requestId" })}: ${fields.requestId}`
      : "",
    fields.traceId ? `Trace ID: ${fields.traceId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 三个引擎共用的行内错误行（docs/desktop/native-plan-errors-spec.md「行内错误行与横幅」）：
 * 重试中显示“正在重新连接 n/m”，终态失败固定在失败轮末尾；展开可见上游原文、HTTP 状态、
 * URL 与请求 ID，并可复制。
 */
export function TurnFailureRow(props: TurnFailureRowProps) {
  const { intl, locale } = useZCodeIntl();
  const diagnostics = useDiagnosticsText(props.fields);
  const [resending, setResending] = useState(false);
  const flight = useRef(false);
  const status =
    props.fields.httpStatus === undefined ? null : (
      <span className="shrink-0 text-ui-sm text-foreground-subtle">
        HTTP {props.fields.httpStatus}
      </span>
    );
  const details = diagnostics ? (
    <ErrorDiagnostics
      text={diagnostics}
      label={intl.formatMessage({ id: "engine.errorDetails" })}
      copyLabel={intl.formatMessage({ id: "engine.copyErrorDetails" })}
    />
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
          {status}
        </div>
        {details}
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
      role="alert"
      className="min-w-0 px-1 text-ui-base"
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <p className="min-w-0 flex-1 select-text break-words text-foreground">{props.summary}</p>
        {status}
        {resend ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={resending}
            onClick={() => void resend()}
            data-testid="turn-failure-resend"
          >
            {intl.formatMessage({ id: "chat.failureRow.resend" })}
          </Button>
        ) : null}
      </div>
      {details}
    </div>
  );
}
