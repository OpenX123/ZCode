// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./e2e/helpers/subagent-refresh-capture.js", () => ({
  readSubagentRows: () => {
    throw new Error("作用域回归不能访问 SQLite");
  },
}));

let candidate: typeof import("./e2e/conversation-session/manual-review/pending/conversation-session-subagent-work-card.test.js");

beforeAll(async () => {
  // 直接导入候选实际调用的只读函数；不注册或模拟运行其 WDIO 生命周期。
  vi.stubGlobal("describe", () => undefined);
  candidate =
    await import("./e2e/conversation-session/manual-review/pending/conversation-session-subagent-work-card.test.js");
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pane(id: string, content: string) {
  const root = document.createElement("div");
  root.dataset.testid = `v4-session-pane-${id}`;
  root.innerHTML = content;
  for (const card of root.querySelectorAll<HTMLElement>("[data-member-count]")) {
    vi.spyOn(card, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  }
  document.body.append(root);
  return root;
}

describe("原 Subagent 工作卡候选的精确父/child 作用域", () => {
  it("child 聚焦且 DOM 首位有其它卡时，仍读取保存的父 pane", async () => {
    pane(
      "focused-child",
      '<div data-testid="v4-subagent-work-card-other" data-member-count="9" data-state="ended">other</div>',
    );
    pane(
      "parent",
      '<div data-testid="v4-subagent-work-card-target" data-member-count="1" data-state="running">target</div>',
    );
    expect(await candidate.readWorkCardState("parent")).toMatchObject({
      cards: 1,
      memberCount: 1,
      state: "running",
      text: "target",
    });
  });

  it("父 scope 不存在时不能用别处卡片兜底", async () => {
    pane(
      "other",
      '<div data-testid="v4-subagent-work-card-other" data-member-count="1">other</div>',
    );
    await expect(candidate.readWorkCardState("missing")).rejects.toThrow("父 pane");
  });

  it("child session 有缓存副本时，行数来自完整原 tab 的 pane", async () => {
    const hidden = pane("cached", '<div data-testid="v4-timeline" data-row-count="99"></div>');
    hidden.dataset.sessionId = "child";
    const original = pane(
      "subagent-session:workspace:parent:child",
      '<div data-testid="v4-timeline" data-row-count="3"></div>',
    );
    original.dataset.sessionId = "child";
    expect(
      await candidate.readChildRowCount("child", "subagent-session:workspace:parent:child"),
    ).toBe(3);
  });

  it("tab 已绑定其它 child 时拒绝，不拿同 session 的缓存副本通过", async () => {
    const cached = pane("cached", '<div data-testid="v4-timeline" data-row-count="99"></div>');
    cached.dataset.sessionId = "child";
    const original = pane("original", '<div data-testid="v4-timeline" data-row-count="3"></div>');
    original.dataset.sessionId = "another-child";
    await expect(candidate.readChildRowCount("child", "original")).rejects.toThrow("child");
  });
});

describe("候选真实调用的primary与逐项cleanup保全", () => {
  it("primary与多项cleanup同时失败，仍执行全部清理并保留primary", async () => {
    const primary = new Error("fixture primary");
    const first = new Error("fixture cleanup first");
    const calls: string[] = [];
    const failure = await candidate
      .runTask13WithCleanup(async (register) => {
        register("first", async () => {
          calls.push("first");
          throw first;
        });
        register("second", async () => {
          calls.push("second");
          throw new Error("fixture cleanup second");
        });
        register("last", async () => {
          calls.push("last");
        });
        throw primary;
      })
      .catch((error: unknown) => error);
    expect(calls).toEqual(["first", "second", "last"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(primary);
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors).toHaveLength(3);
  });

  it("仅cleanup失败不能通过，后续cleanup仍执行", async () => {
    const calls: string[] = [];
    await expect(
      candidate.runTask13WithCleanup(async (register) => {
        register("broken", async () => {
          calls.push("broken");
          throw new Error("fixture cleanup");
        });
        register("last", async () => {
          calls.push("last");
        });
      }),
    ).rejects.toThrow("cleanup");
    expect(calls).toEqual(["broken", "last"]);
  });

  it("证据写入失败不遮蔽primary，清理仍执行", async () => {
    const primary = new Error("fixture primary");
    const cleanup = vi.fn(async () => undefined);
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture evidence"))
      .mockResolvedValue(undefined);
    const failure = await candidate
      .runTask13WithCleanup(async (register) => {
        register("acquired", cleanup);
        throw primary;
      }, record)
      .catch((error: unknown) => error);
    expect(cleanup).toHaveBeenCalledOnce();
    expect((failure as AggregateError).cause).toBe(primary);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(record.mock.calls.map((call) => call[1])).toEqual(["primary", "complete"]);
  });

  it("早期获取失败只清理已取得资源，并在cleanup前记录primary", async () => {
    const calls: string[] = [];
    const primary = new Error("fixture acquire");
    await expect(
      candidate.runTask13WithCleanup(
        async (register) => {
          register("acquired", async () => {
            calls.push("cleanup");
          });
          throw primary;
        },
        async (_outcome, stage) => {
          calls.push(stage);
        },
      ),
    ).rejects.toBe(primary);
    expect(calls).toEqual(["primary", "cleanup", "complete"]);
  });

  it("成功时保持原操作和清理的参数与顺序", async () => {
    const calls: unknown[] = [];
    await candidate.runTask13WithCleanup(async (register) => {
      register("size", async () => {
        calls.push(["size", 1200, 800]);
      });
      register("layout", async () => {
        calls.push(["layout", true, false]);
      });
      calls.push(["body", 1840, 800]);
    });
    expect(calls).toEqual([
      ["body", 1840, 800],
      ["size", 1200, 800],
      ["layout", true, false],
    ]);
  });
});
