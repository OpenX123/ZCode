// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFocusedComposerScope,
  readFocusedComposerScopeInBrowser,
} from "./e2e/helpers/composer-pane-scope.js";
import {
  getUpstreamProviderModelValues,
  selectRegistryProviderModelById,
  waitForUpstreamThoughtLevelSelectedValue,
} from "./e2e/helpers/upstream-provider.js";
import { getV4ModelConfig } from "./e2e/helpers/v4-conversation.js";

function addPane(id: string, focused: boolean, visible: boolean) {
  const pane = document.createElement("div");
  pane.dataset.testid = `v4-pane-shell-${id}`;
  pane.dataset.paneId = id;
  pane.dataset.focused = String(focused);
  pane.dataset.groupActive = "true";
  pane.innerHTML =
    '<div data-testid="v4-composer"><button data-testid="chat-model-select-trigger" data-model-current-value="old-model"></button></div>';
  document.body.append(pane);
  for (const element of [pane, pane.querySelector("button")!]) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: visible ? 600 : 0,
      height: visible ? 200 : 0,
    } as DOMRect);
  }
  return pane;
}

beforeEach(() => {
  Object.assign(window, {
    __zcodeTabStoreE2E: {
      getState: () => ({ activeWorkspacePath: "/remote/a", activeWorkspaceIdentity: "remote:a" }),
    },
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubEnv("ZCODE_E2E_ARTIFACT_DIR", "");
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    waitUntil: async (predicate: () => Promise<boolean>) => expect(await predicate()).toBe(true),
  });
  vi.stubGlobal("$", (selector: string) => {
    const element = document.querySelector<HTMLButtonElement>(selector)!;
    return {
      waitForClickable: async () => {
        if (!element?.getBoundingClientRect().width) throw new Error("命中了缓存隐藏按钮");
      },
      click: async () => element.click(),
      getAttribute: async (name: string) => element.getAttribute(name),
    };
  });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("SSH E2E Composer pane 的显式作用域", () => {
  it("隐藏候选与同时可见的非聚焦栏都不能抢占真实模型点击", async () => {
    const hidden = addPane("cached", true, false);
    const sibling = addPane("sibling", false, true);
    const active = addPane("active", true, true);
    const hiddenClick = vi.fn();
    const siblingClick = vi.fn();
    const activeClick = vi.fn(() => {
      const item = document.createElement("button");
      item.dataset.testid = `chat-model-select-item-${getUpstreamProviderModelValues("target-model", { providerId: "test-provider", includePlainModelFallback: false })[0]}`;
      item.innerText = "target-model";
      item.addEventListener("click", () => {
        active.querySelector("button")!.dataset.modelCurrentValue = "test-provider/target-model";
      });
      document.body.append(item);
    });
    hidden.querySelector("button")!.addEventListener("click", hiddenClick);
    sibling.querySelector("button")!.addEventListener("click", siblingClick);
    active.querySelector("button")!.addEventListener("click", activeClick);
    const composerScope = await getFocusedComposerScope({
      workspacePath: "/remote/a",
      workspaceIdentity: "remote:a",
    });
    await selectRegistryProviderModelById("target-model", {
      providerId: "test-provider",
      includePlainModelFallback: false,
      composerScope,
    });
    expect(composerScope.paneId).toBe("active");
    expect(activeClick).toHaveBeenCalledOnce();
    expect(hiddenClick).not.toHaveBeenCalled();
    expect(siblingClick).not.toHaveBeenCalled();
    expect(active.querySelector("button")!.dataset.modelCurrentValue).toBe(
      "test-provider/target-model",
    );
  });

  it("两个聚焦活动且可见的 pane 拒绝任取第一项", () => {
    addPane("one", true, true);
    addPane("two", true, true);
    expect(() => readFocusedComposerScopeInBrowser("v4-pane-shell")).toThrow("必须唯一，实际 2");
  });

  it("身份不同的相同路径不能作为预期活动工作区", () => {
    addPane("active", true, true);
    expect(() =>
      readFocusedComposerScopeInBrowser("v4-pane-shell", {
        workspacePath: "/remote/a",
        workspaceIdentity: "remote:other",
      }),
    ).toThrow("实际活动 Workspace 与预期不符");
  });

  it("模型与思考投影只读同一个活动 pane，不读取隐藏缓存的旧值", async () => {
    const hidden = addPane("cached", false, false);
    const active = addPane("active", true, true);
    hidden.insertAdjacentHTML(
      "beforeend",
      '<span data-testid="v4-model-config" data-provider="old" data-model="old-model" data-thought="high"></span>',
    );
    active.insertAdjacentHTML(
      "beforeend",
      '<span data-testid="v4-model-config" data-provider="selected" data-model="selected-model" data-thought="disabled"></span>',
    );
    const scope = await getFocusedComposerScope();
    await waitForUpstreamThoughtLevelSelectedValue("disabled", scope.selector);
    expect(await getV4ModelConfig(scope.selector)).toMatchObject({
      provider: "selected",
      model: "selected-model",
      thought: "disabled",
    });
  });
});
