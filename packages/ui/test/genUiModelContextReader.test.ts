import { Emitter } from "@zcode/rpc";
import type { GenUiStateChange, GenUiStateEntry } from "@zcode/shared/gen-ui";
import { describe, expect, it, vi } from "vitest";
import { createGenUiModelContextReader } from "@/gen-ui/host.js";

// docs/desktop/engine-performance-1.1-spec.md「Renderer 发送路径 · Gen UI 上下文」。

const scope = { workspacePath: "/work", sessionId: "session-1" };
const entry = (path: string, modelContent: unknown): GenUiStateEntry => ({
  path,
  state: { modelContent, privateContent: null },
});

function createState(entries: GenUiStateEntry[]) {
  const changes = new Emitter<GenUiStateChange>();
  const listState = vi.fn(async () => entries);
  return { changes, listState, state: { listState, onStateChanged: changes.event } };
}

describe("createGenUiModelContextReader", () => {
  it("同一 scope 连续发送只读取一次状态", async () => {
    const { listState, state } = createState([entry("/work/a.html", { score: 1 })]);
    const reader = createGenUiModelContextReader(state);

    const first = await reader.read(scope);
    const second = await reader.read(scope);

    expect(first).toContain("untrusted_gen_ui_state");
    expect(second).toBe(first);
    expect(listState).toHaveBeenCalledTimes(1);
    reader.dispose();
  });

  it("同 scope 状态变更后重新读取，其他 scope 的变更不影响缓存", async () => {
    const { changes, listState, state } = createState([entry("/work/a.html", { score: 1 })]);
    const reader = createGenUiModelContextReader(state);
    await reader.read(scope);

    changes.fire({
      target: { workspacePath: "/work", sessionId: "other", path: "/work/a.html" },
      state: null,
    });
    await reader.read(scope);
    expect(listState).toHaveBeenCalledTimes(1);

    changes.fire({ target: { ...scope, path: "/work/a.html" }, state: null });
    await reader.read(scope);
    expect(listState).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("读取期间发生变更时本次结果不入缓存", async () => {
    let resolveRead!: (entries: GenUiStateEntry[]) => void;
    const changes = new Emitter<GenUiStateChange>();
    const listState = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GenUiStateEntry[]>((resolve) => {
            resolveRead = resolve;
          }),
      )
      .mockResolvedValue([entry("/work/a.html", { score: 2 })]);
    const reader = createGenUiModelContextReader({ listState, onStateChanged: changes.event });

    const pending = reader.read(scope);
    changes.fire({ target: { ...scope, path: "/work/a.html" }, state: null });
    resolveRead([entry("/work/a.html", { score: 1 })]);
    await expect(pending).resolves.toContain('"score":1');

    await expect(reader.read(scope)).resolves.toContain('"score":2');
    expect(listState).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("workspaceIdentity 参与 scope 隔离，dispose 后释放订阅", async () => {
    const { changes, listState, state } = createState([]);
    const reader = createGenUiModelContextReader(state);
    await reader.read(scope);
    await reader.read({ ...scope, workspaceIdentity: "remote:ssh:dev:/work" });
    expect(listState).toHaveBeenCalledTimes(2);

    reader.dispose();
    expect(() =>
      changes.fire({ target: { ...scope, path: "/work/a.html" }, state: null }),
    ).not.toThrow();
  });
});
