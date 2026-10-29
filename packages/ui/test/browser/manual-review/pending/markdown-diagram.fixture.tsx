import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { applyTheme, type Theme } from "@/useTheme.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = (params.get("theme") ?? "zai-light") as Theme;
applyTheme(theme);
// 组件夹具使用文档滚动；实际应用由会话列表拥有滚动区。
for (const surface of [document.documentElement, document.body, document.getElementById("root")!]) {
  surface.style.height = "auto";
  surface.style.overflow = "visible";
}
const simpleSource = `flowchart ${params.get("direction") === "LR" ? "LR" : "TD"}
  A[各门店到期任务] --> B[账号唯一采集者]
  B --> C{来源会话有效}
  C -->|是| D[逐店串行采集]
  C -->|否| E[账号级统一恢复]
  E -->|成功| D
  E -->|连续失效| F[暂停并提示处理]
  D --> G[各店独立校验与事务发布]
  G --> H[工作台读取本地数据]`;
const complexSource = `flowchart TD
  A[独立采集身份或合法已有会话] --> B[先同步必要目录和近期数据]
  B --> C[按更新时间采集增量]
  C --> D[空窗预算补一个历史小时片]
  D --> E{批次完整且发布成功}
  E -->|是| F[保存完成断点]
  E -->|否| G[保留旧数据和未完成任务]
  F --> H{会话有效且预算充足}
  G --> H
  H -->|是| C
  H -->|否| I[暂停 下次从断点继续]`;
const additionalSources: Record<string, string> = {
  sequence: "sequenceDiagram\n  用户->>服务: 请求数据\n  服务-->>用户: 返回结果",
  state: "stateDiagram-v2\n  [*] --> 等待\n  等待 --> 完成\n  完成 --> [*]",
  subgraph:
    "flowchart TD\n  subgraph group[采集任务]\n    A[准备] --> B[采集]\n  end\n  B --> C[(数据存储)]",
};
const source =
  additionalSources[params.get("diagram") ?? ""] ??
  (params.has("complex") ? complexSource : simpleSource);
const diagramSource = params.has("styled")
  ? `${source}\nclassDef custom fill:#fff1f2,stroke:#be123c,color:#881337,rx:0px,ry:0px;\nclass A,C custom;`
  : params.has("spacious")
    ? `%%{init: {"layout":"dagre","flowchart": {"curve":"basis","nodeSpacing":32,"rankSpacing":44,"padding":16}}}%%\n${source}`
    : source;
const intro = [
  "## 多门店数据同步方案",
  "",
  "多门店同步的关键是：**同一上游账号只有一个采集会话，各门店复用它采集数据，并分别发布。** 员工登录、切换门店，只操作工作台自己的会话。",
  "",
];
const tail = [
  "",
  "具体建议：",
  "- **按账号控制登录。** 同账号逐店串行，不同账号可受限并行。",
  "- **门店状态独立。** 每店保留自己的缓存、任务、水位、重试和发布版本。",
  "",
  "> 来源会话失效时统一恢复，避免每家门店重复重登。",
  "",
  "| 检查项 | 状态 |",
  "| --- | --- |",
  "| 完整展示 | 随正文展开 |",
  "| 主题与字体 | 跟随应用 |",
  "",
  "```typescript",
  "const result = await collectStore(storeId);",
  "```",
];

function Fixture() {
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<"complete" | "streaming" | "partial">(
    params.has("streaming") ? "streaming" : "complete",
  );
  const [fontSizePx, setFontSizePx] = useState(14);
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <div className="min-h-screen bg-background text-foreground">
          <nav className="flex flex-wrap gap-4 p-3">
            <button onClick={() => setVisible(!visible)}>切换挂载</button>
            <button onClick={() => setPhase(phase === "partial" ? "complete" : "partial")}>
              切换流式
            </button>
            <button onClick={() => setFontSizePx(fontSizePx === 14 ? 20 : 14)}>切换字体</button>
          </nav>
          <main className="mx-auto max-w-3xl px-6 pt-6 pb-16">
            {visible ? (
              <MessageResponse
                theme={theme}
                streaming={phase !== "complete"}
                codePreviewSettings={{ ...DEFAULT_CODE_PREVIEW_SETTINGS, fontSizePx }}
              >
                {[
                  ...intro,
                  "```mermaid",
                  diagramSource,
                  ...(phase === "partial"
                    ? ["Broken(\ntail"]
                    : phase === "streaming"
                      ? [""]
                      : ["```", ...tail]),
                ].join("\n")}
              </MessageResponse>
            ) : null}
          </main>
        </div>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
