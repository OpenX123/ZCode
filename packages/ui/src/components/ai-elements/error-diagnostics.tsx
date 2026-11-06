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
