import { describe, expect, it } from "vitest";
import type {
  BackgroundWorkSummary,
  ConversationRow,
  RowsWindow,
  SubagentProjectionState,
} from "@zcode/shared/zcode-protocol-v4";
import { FACE_COLORS, agentColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import {
  buildSubagentAvatarIndex,
  buildSubagentSessionHeaderModel,
  faceStatusOf,
  formatSubagentNameList,
  formatSubagentNameListParts,
  resolveAgentSpawnStatus,
  resolveSubagentAvatarIndexes,
  resolveSubagentFaceVariant,
  subagentDisplayName,
  summarizeSubagentStatuses,
} from "@/subagent-display/model.js";

describe("头像序号（docs/desktop/multi-agent-display-spec.md「序号」）", () => {
  it("按父会话清单的派发顺序取序号，重复项取首次出现", () => {
    const index = buildSubagentAvatarIndex(["a", "b", "a", "c"]);
    expect(index.size).toBe(3);
    expect(["a", "b", "c"].map((id) => index.indexOf(id))).toEqual([0, 1, 2]);
    expect(index.indexOf("missing")).toBeUndefined();
    expect(index.indexOf(undefined)).toBeUndefined();
  });

  it("重渲染、重连与冷恢复得到同一清单时序号不变，颜色取九色板并从第十个循环", () => {
    const live = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    // 冷恢复种子是一份内容相同的新数组（不同引用），结果必须逐项相同。
    const restored = [...live];
    const liveIndexes = resolveSubagentAvatarIndexes(buildSubagentAvatarIndex(live), live);
    const restoredIndexes = resolveSubagentAvatarIndexes(
      buildSubagentAvatarIndex(restored),
      restored,
    );
    expect(restoredIndexes).toEqual(liveIndexes);
    expect(liveIndexes.map((index) => agentColor(index, "same name"))).toEqual([
      ...FACE_COLORS,
      FACE_COLORS[0],
    ]);
  });

  it("未登记成员从清单长度起编临时序号，登记后改用清单序号", () => {
    const before = buildSubagentAvatarIndex(["a", "b"]);
    expect(resolveSubagentAvatarIndexes(before, ["b", undefined, "pending-x", null])).toEqual([
      1, 2, 3, 4,
    ]);
    const after = buildSubagentAvatarIndex(["a", "b", "pending-x"]);
    expect(resolveSubagentAvatarIndexes(after, ["pending-x"])).toEqual([2]);
  });

  it("edit/retry 剪掉旧分支后后续成员前移（分支变化而非漂移）", () => {
    const branch = buildSubagentAvatarIndex(["kept", "later"]);
    expect(branch.indexOf("later")).toBe(1);
  });
});

describe("轮廓变体映射", () => {
  it.each([
    ["Explore", "antenna"],
    ["explorer", "antenna"],
    ["web-search", "antenna"],
    ["Plan", "visor"],
    ["planner", "visor"],
    ["code-reviewer", "glasses"],
    ["verifier", "glasses"],
    ["test-runner", "crest"],
    ["qa", "crest"],
    ["researcher", "ears"],
    ["deepResearch", "ears"],
    ["general-purpose", "base"],
    ["worker", "base"],
    ["statusline-setup", "base"],
    ["", "base"],
    [undefined, "base"],
  ] as const)("%s → %s", (subagentType, variant) => {
    expect(resolveSubagentFaceVariant(subagentType)).toBe(variant);
  });

  it("至少六种变体都可达", () => {
    const variants = new Set(
      ["general-purpose", "Explore", "Plan", "reviewer", "tester", "research"].map(
        resolveSubagentFaceVariant,
      ),
    );
    expect(variants.size).toBe(6);
  });
});

describe("名称与列表格式", () => {
  it("中文与英文按 Intl.ListFormat 连接", () => {
    expect(formatSubagentNameList(["A", "B", "C"], "zh-CN")).toBe("A、B和C");
    expect(formatSubagentNameList(["A", "B", "C"], "en-US")).toBe("A, B, and C");
    expect(formatSubagentNameList(["A", "B"], "en-US")).toBe("A and B");
  });

  it("片段按输入顺序给出名称下标，字面量原样保留", () => {
    expect(formatSubagentNameListParts(["A", "B", "C"], "en-US")).toEqual([
      { type: "element", index: 0 },
      { type: "literal", value: ", " },
      { type: "element", index: 1 },
      { type: "literal", value: ", and " },
      { type: "element", index: 2 },
    ]);
  });

  it("名称：标题 → 类型 → 本地化兜底", () => {
    expect(
      subagentDisplayName({ title: " 找文件 ", subagentType: "Explore", fallbackName: "智能体 1" }),
    ).toBe("找文件");
    expect(subagentDisplayName({ title: "", subagentType: "Explore", fallbackName: "x" })).toBe(
      "Explore",
    );
    expect(subagentDisplayName({ title: "", subagentType: " ", fallbackName: "智能体 3" })).toBe(
      "智能体 3",
    );
  });
});

describe("状态", () => {
  it("配对的 subagent 行优先于工具调用状态（后台 Agent 启动即成功）", () => {
    expect(resolveAgentSpawnStatus({ status: "success" }, { status: "running" })).toBe("running");
    expect(resolveAgentSpawnStatus({ status: "running" }, { status: "failed" })).toBe("failed");
    expect(resolveAgentSpawnStatus({ status: "inputStreaming" })).toBe("pending");
    expect(resolveAgentSpawnStatus({ status: "error" })).toBe("failed");
    expect(resolveAgentSpawnStatus({ status: "cancelled" })).toBe("cancelled");
  });

  it("表情只读状态；计数把等待/阻塞算作运行中", () => {
    expect(faceStatusOf("waiting")).toBe("running");
    expect(faceStatusOf("cancelled")).toBe("failed");
    expect(
      summarizeSubagentStatuses(["running", "waiting", "done", "failed", "cancelled"]),
    ).toEqual({ running: 2, done: 1, failed: 1, cancelled: 1 });
  });
});

function manifest(overrides: Partial<SubagentProjectionState> = {}): SubagentProjectionState {
  return { revision: 3, childSessionIds: ["c-a", "c-b"], running: [], endedTotal: 0, ...overrides };
}

function work(overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary {
  return {
    workId: "w-b",
    kind: "subagent",
    title: "review",
    status: "running",
    startedAt: 1_000,
    anchorRowId: null,
    childSessionId: "c-b",
    ...overrides,
  };
}

function rows(window: Array<Record<string, unknown>>, firstRowId = 1): RowsWindow {
  return { window: window as unknown as ConversationRow[], totalCount: window.length, firstRowId };
}

describe("右侧详情头部模型", () => {
  it("运行态取父会话 running，停止只来自精确匹配的可停 work", () => {
    const model = buildSubagentSessionHeaderModel({
      childSessionId: "c-b",
      subagentType: "code-reviewer",
      parent: {
        subagents: manifest({
          running: [
            {
              childSessionId: "c-b",
              subagentType: "code-reviewer",
              title: "review",
              status: "waiting",
              startedAt: 5_000,
            },
          ],
        }),
        backgroundWorks: [work()],
      },
      child: null,
    });
    expect(model).toEqual({
      avatarIndex: 1,
      variant: "glasses",
      status: "waiting",
      startedAt: 5_000,
      stopWorkId: "w-b",
    });
  });

  it("前台（无 work）、重复身份或不可停时不提供停止", () => {
    const running = manifest({
      running: [{ childSessionId: "c-b", subagentType: "x", title: "t", status: "running" }],
    });
    for (const backgroundWorks of [
      [],
      [work(), work({ workId: "w-dup" })],
      [work({ cancellable: false })],
    ]) {
      const model = buildSubagentSessionHeaderModel({
        childSessionId: "c-b",
        parent: { subagents: running, backgroundWorks },
        child: null,
      });
      expect(model.stopWorkId).toBeUndefined();
    }
  });

  it("结束后取子会话 control 与到顶行窗口的首尾 turnHeader", () => {
    const window = rows([
      { kind: "turnHeader", rowId: 1, startedAt: 10_000, endedAt: 20_000 },
      { kind: "assistantText", rowId: 2 },
      { kind: "turnHeader", rowId: 3, startedAt: 30_000, endedAt: 75_000 },
    ]);
    const done = buildSubagentSessionHeaderModel({
      childSessionId: "c-a",
      parent: { subagents: manifest(), backgroundWorks: [work({ childSessionId: "c-a" })] },
      child: { control: { phase: "completedSuccess", lastError: null }, rows: window },
    });
    expect(done).toMatchObject({
      avatarIndex: 0,
      status: "done",
      startedAt: 10_000,
      endedAt: 75_000,
    });
    expect(done.stopWorkId).toBeUndefined();

    const failed = buildSubagentSessionHeaderModel({
      childSessionId: "c-a",
      parent: { subagents: manifest() },
      child: {
        control: { phase: "completedSuccess", lastError: { message: "boom" } as never },
        rows: rows([{ kind: "assistantText", rowId: 9 }], 1),
      },
    });
    expect(failed.status).toBe("failed");
    // 行窗口未到顶：不知道真正的开始，就不显示耗时。
    expect(failed.startedAt).toBeUndefined();

    const stopped = buildSubagentSessionHeaderModel({
      childSessionId: "c-a",
      parent: null,
      child: { control: { phase: "completedInterrupted", lastError: null } },
    });
    expect(stopped).toMatchObject({ status: "cancelled", avatarIndex: undefined, variant: "base" });
  });
});
