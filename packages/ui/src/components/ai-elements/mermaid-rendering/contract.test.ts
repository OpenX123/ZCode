// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectClosedMarkdownFences,
  completeMermaidSourceLines,
  createMermaidLiveRenderer,
  createMermaidRenderCoordinator,
  namespaceMermaidSvg,
} from "./index.js";

const request = (source: string) => ({ source, config: { theme: "base" as const } });
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => vi.useRealTimers());

describe("Mermaid 成功缓存与并发契约", () => {
  it("同键共享进行中请求并同步读取成功缓存，不混淆实际主题和字体", async () => {
    const render = vi.fn(async () => "<svg/> ");
    const coordinator = createMermaidRenderCoordinator(render);
    const first = coordinator.render(request("A"));
    const second = coordinator.render(request("A"));
    expect(first).toBe(second);
    await first;
    expect(coordinator.peek(request("A"))).toBe("<svg/> ");
    await coordinator.render({ ...request("A"), config: { theme: "dark", fontFamily: "serif" } });
    await coordinator.render({
      ...request("A"),
      config: { theme: "dark", fontFamily: "serif", fontSize: 18 },
    });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("全局串行并在失败后继续，失败不进入缓存", async () => {
    let finish!: (svg: string) => void;
    const render = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            finish = r;
          }),
      )
      .mockRejectedValueOnce(new Error("bad source"))
      .mockResolvedValue("ok");
    const coordinator = createMermaidRenderCoordinator(render);
    const first = coordinator.render(request("A"));
    const failed = coordinator.render(request("bad"));
    const failure = expect(failed).rejects.toThrow("bad source");
    await tick();
    expect(render).toHaveBeenCalledTimes(1);
    finish("first");
    await first;
    await failure;
    expect(coordinator.peek(request("bad"))).toBeUndefined();
    await coordinator.render(request("bad"));
    expect(coordinator.peek(request("bad"))).toBe("ok");
  });

  it("按 LRU 条数及源码和 SVG 的内存预算淘汰", async () => {
    const coordinator = createMermaidRenderCoordinator(async () => "svg", { maxEntries: 2 });
    await coordinator.render(request("A"));
    await coordinator.render(request("B"));
    coordinator.peek(request("A"));
    await coordinator.render(request("C"));
    expect(coordinator.peek(request("A"))).toBe("svg");
    expect(coordinator.peek(request("B"))).toBeUndefined();
    const tiny = createMermaidRenderCoordinator(async () => "oversized", { maxBytes: 4 });
    await tiny.render(request("A"));
    expect(tiny.peek(request("A"))).toBeUndefined();
  });
});

describe("Mermaid 最新流式候选", () => {
  it("连续增量不会无限推迟首图，固定预算时刻渲染当时最新候选", async () => {
    vi.useFakeTimers();
    const render = vi.fn(async (_id: string, source: string) => source);
    const live = createMermaidLiveRenderer(createMermaidRenderCoordinator(render), {
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    live.update({ ...request("first\n"), complete: false });
    await vi.advanceTimersByTimeAsync(80);
    live.update({ ...request("latest\n"), complete: false });
    await vi.advanceTimersByTimeAsync(80);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[1]).toBe("latest");
    live.dispose();
  });

  it("合并 token 候选，执行中只保留最后版本，旧结果不能覆盖新图", async () => {
    vi.useFakeTimers();
    const pending: Array<(svg: string) => void> = [];
    const render = vi.fn(
      (_id: string, _source: string) => new Promise<string>((r) => pending.push(r)),
    );
    const onSuccess = vi.fn();
    const live = createMermaidLiveRenderer(createMermaidRenderCoordinator(render), {
      onSuccess,
      onError: vi.fn(),
    });
    live.update({ ...request("A\n"), complete: false });
    live.update({ ...request("B\n"), complete: false });
    await vi.advanceTimersByTimeAsync(180);
    expect(render).toHaveBeenCalledTimes(1);
    live.update({ ...request("C\n"), complete: false });
    live.update({ ...request("D"), complete: true });
    pending[0]!("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[1]).toBe("D");
    pending[1]!("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledWith("new", expect.objectContaining({ source: "D" }));
    live.dispose();
  });

  it("隐藏期间不启动工作，恢复只渲染最新版本，dispose 后不提交", async () => {
    const render = vi.fn(async () => "svg");
    const onSuccess = vi.fn();
    const live = createMermaidLiveRenderer(createMermaidRenderCoordinator(render), {
      onSuccess,
      onError: vi.fn(),
    });
    live.setEnabled(false);
    live.update({ ...request("A"), complete: true });
    live.update({ ...request("B"), complete: true });
    await tick();
    expect(render).not.toHaveBeenCalled();
    live.setEnabled(true);
    live.dispose();
    await tick();
    await tick();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("只有最终候选的错误对 UI 可见，半截源码失败不会撤掉成功图", async () => {
    vi.useFakeTimers();
    const coordinator = createMermaidRenderCoordinator(async (_id, source) => {
      if (source === "bad") throw new Error("parse failed");
      return "good";
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const live = createMermaidLiveRenderer(coordinator, { onSuccess, onError });
    live.update({ ...request("good"), complete: true });
    await vi.advanceTimersByTimeAsync(0);
    live.update({ ...request("bad"), complete: false });
    await vi.advanceTimersByTimeAsync(180);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    live.update({ ...request("bad"), complete: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    live.dispose();
  });
});

it("只把原始 Markdown 已闭合围栏标为最终候选，不能接受补全 fence", () => {
  const markdown = "```mermaid\ngraph TD\nA-->B\n```\n继续输出\n~~~mermaid\ngraph TD\nC-->";
  expect([...collectClosedMarkdownFences(markdown)]).toEqual(["graph TD\nA-->B"]);
});

it("未闭合图表只提交完整行，首行尚未完成时等待后续增量", () => {
  expect(completeMermaidSourceLines("flowchart TD")).toBe("");
  expect(completeMermaidSourceLines("flowchart TD\nA-->B\nC-->")).toBe("flowchart TD\nA-->B");
});

it("两个聊天实例和预览各自隔离 ID，保持颜色、CSS selector 与 SVG fragment 引用", () => {
  const svg =
    '<svg id="diagram"><style>#diagram .edge{stroke:#abc;marker-end:url(#arrow)}#node:hover{fill:red}</style><defs><marker id="arrow"/></defs><g id="node" aria-labelledby="label node"><text id="label">node</text><use href="#node"/><path marker-end="url(#arrow)" fill="#abc"/></g></svg>';
  const left = namespaceMermaidSvg(svg, "left");
  const right = namespaceMermaidSvg(svg, "right");
  expect(left).toContain('id="left-diagram"');
  expect(left).toContain("#left-diagram .edge");
  expect(left).toContain("#left-node:hover");
  expect(left).toContain("url(#left-arrow)");
  expect(left).toContain('href="#left-node"');
  expect(left).toContain('aria-labelledby="left-label left-node"');
  expect(left).toContain('fill="#abc"');
  expect(right).not.toContain("left-");
});
