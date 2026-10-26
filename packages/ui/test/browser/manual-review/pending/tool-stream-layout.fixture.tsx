import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const base = { turnId: "tool-stream", createdAt: 1_700_000_000_000, createdAtSeq: 1 };
const command = `gh api repos/example/project/git/trees/main?recursive=1 --jq '.tree[] | select(.path|test("plugins|marketplace|official-plugins"))'`;
function tool(index: number, status: ToolCallRow["status"]): ToolCallRow {
  return {
    ...base,
    rowId: index + 3,
    kind: "toolCall",
    toolCallId: `stream-${index}`,
    toolName: index % 4 === 2 ? "Bash" : index % 2 === 0 ? command : "Guardian Review",
    status: index % 4 === 2 ? "error" : status,
    input: { command },
    inputText: JSON.stringify({ command }),
    ...(index % 4 === 2
      ? { error: { message: "命令执行失败，请检查参数" } }
      : status === "success"
        ? { output: { text: "已完成检查" } }
        : {}),
  };
}
function Fixture() {
  const [count, setCount] = useState(6);
  const [complete, setComplete] = useState(false);
  const rows: ConversationRow[] = [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: complete ? "completedSuccess" : "running",
      startedAt: base.createdAt,
    },
    {
      ...base,
      rowId: 2,
      kind: "userInput",
      origin: "realUser",
      text: "检查项目中的插件入口，并连续展示执行进度。",
    },
    ...Array.from({ length: count }, (_, i) =>
      tool(i, i === count - 1 && !complete ? "running" : "success"),
    ),
  ];
  const unit = buildConversationTurnRenderUnits(rows)[0]!;
  return (
    <ZCodeIntlProvider initialLocale={query.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
      <TooltipProvider>
        <main className="@container/conversation min-h-dvh bg-background text-foreground">
          <nav className="flex gap-4 p-4 text-ui-base">
            <button onClick={() => setCount((value) => value + 2)}>追加工具</button>
            <button onClick={() => setComplete(true)}>完成</button>
          </nav>
          <ConversationTurnGroup
            unit={unit}
            context={{
              codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
              theme,
              workspacePath: "/fixture",
              toolGroupingTerminalEnabled: false,
            }}
          />
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
