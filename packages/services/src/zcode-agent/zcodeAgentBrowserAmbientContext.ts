import { randomUUID } from "node:crypto";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  browserCommandResultSchema,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  type ZCodeBrowserAmbientContext,
} from "@zcode/shared";

export interface BrowserAmbientContextExecutor {
  list(input: {
    requestId: string;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
  }): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
    command: BrowserCommand;
  }): Promise<{ ok: boolean; [key: string]: unknown }>;
}

interface BrowserAmbientContextTarget {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: BrowserClientMode;
}

function sanitizeAmbientUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!["about:", "http:", "https:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    const value = url.toString();
    return value.length <= 4096 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 发送准入等待环境上下文的上限。环境上下文只是尽力附加的信息：Host 没有浏览器页面存在性的
 * 廉价事实（标签列表归 Main 所有），过去每次发送都等 Host→Main 两次 execute，Main 忙或页面
 * executeJavaScript 卡住时最多被 30s 桥预算拖住。超出本预算时本轮不带环境上下文，迟到结果丢弃。
 * 见 docs/desktop/engine-performance-1.1-spec.md「浏览器环境上下文」。
 */
export const BROWSER_AMBIENT_CONTEXT_BUDGET_MS = 150;

const logger = createServiceLogger("browser-ambient-context");

/**
 * 只读收集 provider ambient state。失败或超出预算时返回 undefined，不能让浏览器 UI 状态阻断真实 prompt。
 */
export async function collectBrowserAmbientContext(
  executor: BrowserAmbientContextExecutor | undefined,
  target: BrowserAmbientContextTarget,
  options: { budgetMs?: number } = {},
): Promise<ZCodeBrowserAmbientContext | undefined> {
  if (!executor) return undefined;
  const budgetMs = options.budgetMs ?? BROWSER_AMBIENT_CONTEXT_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetExceeded = new Promise<"budget-exceeded">((resolve) => {
    timer = setTimeout(() => resolve("budget-exceeded"), budgetMs);
  });
  try {
    const outcome = await Promise.race([
      readBrowserAmbientContext(executor, target),
      budgetExceeded,
    ]);
    if (outcome !== "budget-exceeded") return outcome;
    logger.debug(undefined, "浏览器环境上下文超出发送预算，本轮不附带", {
      budgetMs,
      sessionId: target.sessionId,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function readBrowserAmbientContext(
  executor: BrowserAmbientContextExecutor,
  target: BrowserAmbientContextTarget,
): Promise<ZCodeBrowserAmbientContext | undefined> {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const clientMode = target.clientMode ?? "desktop-continuous";
  const common = {
    sessionId: target.sessionId,
    workspaceKey,
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    clientMode,
    sessionContext: "live" as const,
  };

  try {
    const descriptors = await executor.list({
      requestId: randomUUID(),
      ...common,
    });
    const browser = descriptors.find((candidate) => candidate.type === "iab");
    if (!browser) return undefined;

    const [controlledOutcome, userOutcome] = await Promise.allSettled([
      executor.execute({
        requestId: randomUUID(),
        browserId: browser.id,
        browserGeneration: browser.generation,
        ...common,
        command: { method: "list" },
      }),
      executor.execute({
        requestId: randomUUID(),
        browserId: browser.id,
        browserGeneration: browser.generation,
        ...common,
        command: { method: "listUserTabs" },
      }),
    ]);
    const controlled =
      controlledOutcome.status === "fulfilled"
        ? browserCommandResultSchema.safeParse(controlledOutcome.value)
        : undefined;
    const users =
      userOutcome.status === "fulfilled"
        ? browserCommandResultSchema.safeParse(userOutcome.value)
        : undefined;
    const controlledTabs =
      controlled?.success && controlled.data.ok ? (controlled.data.tabs ?? []) : [];
    const userTabs = users?.success && users.data.ok ? (users.data.userTabs ?? []) : [];
    const tabIds = new Set([
      ...controlledTabs.map((tab) => tab.tabId),
      ...userTabs.map((tab) => tab.id),
    ]);
    if (tabIds.size === 0) return undefined;

    // 显式 finalize 后页面属于 user tabs；漏 finalize 的 handoff 仍属于 controlled tabs。
    // 两类都必须进入 ambient state，否则下一轮会把空 tabs.list() 误判为浏览器断线。
    const currentControlled = controlledTabs.find((tab) => tab.active);
    const currentUrl = sanitizeAmbientUrl(
      currentControlled?.url ?? userTabs[0]?.url ?? controlledTabs.at(-1)?.url,
    );
    return {
      tabCount: tabIds.size,
      ...(currentUrl ? { currentUrl } : {}),
    };
  } catch {
    return undefined;
  }
}
