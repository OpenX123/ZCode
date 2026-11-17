import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_CHAT_MODEL_SELECT_TRIGGER, TID_V4_PANE_SHELL } from "@zcode/shared/test-ids";

export interface ComposerPaneScope {
  paneId: string;
  selector: string;
  workspacePath: string;
  workspaceIdentity: string | null;
}

type FocusedPaneScope = Pick<ComposerPaneScope, "paneId" | "selector">;
type ExpectedComposerWorkspace = { workspacePath: string; workspaceIdentity?: string };

/** 只读取既有活动工作区桥和 pane DOM，不改焦点、布局或 Store。 */
export function readFocusedComposerScopeInBrowser(
  shellPrefix: string,
  expected?: ExpectedComposerWorkspace,
  mode?: "composer",
): ComposerPaneScope;
export function readFocusedComposerScopeInBrowser(
  shellPrefix: string,
  expected: undefined,
  mode: "pane-only",
): FocusedPaneScope | null;
export function readFocusedComposerScopeInBrowser(
  shellPrefix: string,
  expected: ExpectedComposerWorkspace | undefined,
  mode: "composer" | "pane-only",
): ComposerPaneScope | FocusedPaneScope | null;
export function readFocusedComposerScopeInBrowser(
  shellPrefix: string,
  expected?: ExpectedComposerWorkspace,
  mode: "composer" | "pane-only" = "composer",
): ComposerPaneScope | FocusedPaneScope | null {
  const state = (
    window as Window & {
      __zcodeTabStoreE2E?: {
        getState(): {
          activeWorkspacePath?: string | null;
          activeWorkspaceIdentity?: string | null;
        };
      };
    }
  ).__zcodeTabStoreE2E?.getState();
  const path = state?.activeWorkspacePath;
  const identity = state?.activeWorkspaceIdentity?.trim() || null;
  // 已证原因：缓存隐藏 pane 保留同 test id；双栏也会同时可见，必须同时核焦点和活动组。
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid^="${shellPrefix}-"][data-focused="true"][data-group-active="true"]`,
    ),
  ).filter((pane) => {
    const rect = pane.getBoundingClientRect();
    const style = getComputedStyle(pane);
    return (
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    );
  });
  // pane-only 只发现当前真实焦点；初始化无候选仍由调用方原等待处理，歧义不能取第一项。
  if (mode === "pane-only" && candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new Error(`活动 Composer pane 必须唯一，实际 ${candidates.length}`);
  const pane = candidates[0]!;
  const paneId = pane.getAttribute("data-pane-id");
  if (!paneId) throw new Error("活动 pane 缺少 paneId");
  const selector = `[data-testid="${CSS.escape(`${shellPrefix}-${paneId}`)}"]`;
  if (mode === "pane-only") return { paneId, selector };
  if (
    !path ||
    (expected &&
      (path !== expected.workspacePath ||
        (expected.workspaceIdentity && identity !== expected.workspaceIdentity)))
  )
    throw new Error("Composer 的实际活动 Workspace 与预期不符");
  if (pane.querySelectorAll('[data-testid="v4-composer"]').length !== 1)
    throw new Error("活动 pane 没有唯一 Composer");
  const headerPath = pane
    .querySelector("[data-workspace-abs-path]")
    ?.getAttribute("data-workspace-abs-path");
  if (headerPath && headerPath !== path) throw new Error("活动 pane 的 Workspace 路径不符");
  return {
    paneId,
    selector,
    workspacePath: path,
    workspaceIdentity: identity,
  };
}

export async function getFocusedComposerScope(expected?: {
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<ComposerPaneScope> {
  const scope = await browser.execute(
    readFocusedComposerScopeInBrowser,
    TID_V4_PANE_SHELL,
    expected,
    "composer" as const,
  );
  // browser.execute 对重载只保留联合返回；明确核字段，不能把 pane-only 强断言为完整 Composer。
  if (
    !scope ||
    !("workspacePath" in scope) ||
    typeof scope.workspacePath !== "string" ||
    !("workspaceIdentity" in scope) ||
    (scope.workspaceIdentity !== null && typeof scope.workspaceIdentity !== "string")
  )
    throw new Error("Composer scope 缺少完整 Workspace 身份");
  return {
    paneId: scope.paneId,
    selector: scope.selector,
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  };
}

/** 被动记录导航前后身份和几何，不读正文、输入、配置或整个 Store。 */
export async function recordTaskNavigationScope(stage: string, expectedSessionId: string) {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  const observation = await browser.execute((shellPrefix) => {
    const state = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeTabId?: string | null;
            activeWorkspacePath?: string | null;
            activeWorkspaceIdentity?: string | null;
          };
        };
      }
    ).__zcodeTabStoreE2E?.getState();
    return {
      activeTabId: state?.activeTabId ?? null,
      activeWorkspacePath: state?.activeWorkspacePath ?? null,
      activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
      panes: [...document.querySelectorAll<HTMLElement>(`[data-testid^="${shellPrefix}-"]`)].map(
        (pane) => {
          const rect = pane.getBoundingClientRect();
          const style = getComputedStyle(pane);
          return {
            paneId: pane.getAttribute("data-pane-id"),
            sessionIds: [...pane.querySelectorAll('[data-testid^="v4-session-pane-"]')].map(
              (item) => item.getAttribute("data-session-id"),
            ),
            focused: pane.getAttribute("data-focused"),
            groupActive: pane.getAttribute("data-group-active"),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden",
          };
        },
      ),
    };
  }, TID_V4_PANE_SHELL);
  await mkdir(artifactDir, { recursive: true });
  await appendFile(
    resolve(artifactDir, "task-navigation-scope.ndjson"),
    `${JSON.stringify({ observedAt: new Date().toISOString(), stage, expectedSessionId, ...observation })}\n`,
  );
}

/** 只写实际定位/调用返回证据，不保存文本、输入值或完整 DOM。 */
export async function recordComposerScopeAction(
  scope: ComposerPaneScope,
  action: string,
  modelItemTestId?: string,
) {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  const target = await browser.execute(
    (selector, triggerTestId) => {
      const pane = document.querySelector(selector);
      const triggers =
        pane?.querySelectorAll<HTMLButtonElement>(`[data-testid="${triggerTestId}"]`) ?? [];
      const trigger = triggers[0];
      const rect = trigger?.getBoundingClientRect();
      return {
        paneId: pane?.getAttribute("data-pane-id") ?? null,
        focused: pane?.getAttribute("data-focused") ?? null,
        groupActive: pane?.getAttribute("data-group-active") ?? null,
        triggerCount: triggers.length,
        disabled: trigger?.disabled ?? null,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      };
    },
    scope.selector,
    TID_CHAT_MODEL_SELECT_TRIGGER,
  );
  if (
    target.paneId !== scope.paneId ||
    target.focused !== "true" ||
    target.groupActive !== "true" ||
    target.triggerCount !== 1
  )
    throw new Error("模型选择的实际目标已不再是唯一活动 Composer");
  await mkdir(artifactDir, { recursive: true });
  await appendFile(
    resolve(artifactDir, "composer-scope-actions.ndjson"),
    `${JSON.stringify({ observedAt: new Date().toISOString(), action, scope, target, ...(modelItemTestId ? { modelItemTestId } : {}) })}\n`,
  );
}
