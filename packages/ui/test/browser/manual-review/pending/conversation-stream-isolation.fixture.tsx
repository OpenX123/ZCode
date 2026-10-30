import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { advanceConversationRowsPartition } from "@/v4/conversationProjectionStore.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const compact = params.get("mobile") === "true";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const startedAt = Date.now();
function turn(turnId: string, index: number, running = false): ConversationRow[] {
  const base = { turnId, createdAt: startedAt, createdAtSeq: index * 3 + 1 };
  return [
    {
      ...base,
      rowId: index * 3 + 1,
      kind: "turnHeader",
      origin: "userInput",
      state: running ? "running" : "completedSuccess",
      startedAt,
      ...(!running ? { endedAt: startedAt + 1000, activeMs: 1000 } : {}),
    },
    {
      ...base,
      rowId: index * 3 + 2,
      kind: "userInput",
      origin: "realUser",
      text: `问题 ${turnId}`,
    },
    {
      ...base,
      rowId: index * 3 + 3,
      kind: "assistantText",
      text: running ? "流式输出 0" : `历史回答 ${turnId} needle`,
      state: running ? "streaming" : "complete",
    },
  ];
}
const initial = [...turn("history-0", 0), ...turn("history-1", 1), ...turn("active", 2, true)];
function Fixture() {
  const [rows, setRows] = useState(initial);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const rowContext = useMemo(
    () => ({
      workspacePath: "/fixture",
      sessionId: "stream",
      theme,
      compactForRemoteControl: compact,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [],
  );
  const onFindState = useCallback(
    (state: { matchCount: number }) => setMatchCount(state.matchCount),
    [],
  );
  const updateTail = () =>
    setRows((previous) => {
      const last = previous.at(-1)!;
      if (last.kind !== "assistantText") throw new Error("fixture tail");
      const row = { ...last, text: `${last.text} token` };
      const next = [...previous.slice(0, -1), row];
      advanceConversationRowsPartition(previous, next, [{ op: "row.upserted", row }]);
      return next;
    });
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <div className="flex h-dvh flex-col bg-background text-foreground">
          <nav className="flex shrink-0 gap-2 text-ui-caption">
            <button data-testid="token" onClick={updateTail}>
              追加 token
            </button>
            <button
              data-testid="revise"
              onClick={() =>
                setRows((previous) =>
                  previous.map((row) =>
                    row.rowId === 3 && row.kind === "assistantText"
                      ? { ...row, text: "已修订回答" }
                      : row,
                  ),
                )
              }
            >
              修订历史
            </button>
            <input
              data-testid="find"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <output data-testid="matches">{matchCount}</output>
          </nav>
          <ConversationTimeline
            rows={rows}
            totalCount={rows.length}
            sessionKey="stream"
            rowContext={rowContext}
            compactForRemoteControl={compact}
            sessionPhase="running"
            conversationFindQuery={query}
            onConversationFindMatchStateChange={onFindState}
            hideTurnNavigator
          />
        </div>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
