import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/**
 * 新用户 / 所属范围无 Recent 时的默认权限：自主模式（用户决策 2026-11-09「自主 + 高」）。
 * 只用于"新默认"；历史快照缺 mode 的解析默认与非法旧值回落仍为 build（安全回落）。
 */
export const DEFAULT_NEW_SESSION_PERMISSION_MODE = "guarded" satisfies SubmissionMode;

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  return {
    ...draft,
    // 无 Recent（新用户/新范围）默认自主模式；Recent 为 plan 时仍回落 build（Plan 不沿用）。
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? DEFAULT_NEW_SESSION_PERMISSION_MODE),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
