import { useCallback, useEffect, useState } from "react";
import { isFeishuBotProvider, type BotContextState, type FeishuBotProvider } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { createSharedServiceRead, type SharedServiceRead } from "@/store/serviceAuthorityKey.js";

type BotStatesSource = Pick<IServiceAccessor["botsService"], "getBotStates">;
type BotStatesBroadcastSource = Pick<IServiceAccessor["broadcastService"], "onMessage">;
type SharedBotStatesReader = SharedServiceRead<void, BotContextState[], void>;

const BOT_GROUP_STATE_CHANNEL = "bots:group-state";
const sharedBotStatesReaders = new WeakMap<
  BotStatesSource,
  WeakMap<BotStatesBroadcastSource, SharedBotStatesReader>
>();

/**
 * Bot 状态的窗口级共享读取（P5，docs/desktop/engine-performance-1.1-spec.md「窗口级只读数据共享」）。
 * 修复原因：每个 SessionPane 的 BotGroupDeliveryProvider 各读一次全量 getBotStates（窗口打开实测 12 次，
 * Host 0.21→1.94s 阶梯），每次 bots:group-state 广播再各自重读。按（botsService, broadcastService）
 * 服务实例共享：只读一次、只订阅一次广播；广播只作失效信号，到达后各实例的重读合并为一次请求。
 */
export function getSharedBotStatesReader(
  botsService: BotStatesSource,
  broadcastService: BotStatesBroadcastSource,
): SharedBotStatesReader {
  let byBroadcast = sharedBotStatesReaders.get(botsService);
  if (!byBroadcast) {
    byBroadcast = new WeakMap();
    sharedBotStatesReaders.set(botsService, byBroadcast);
  }
  const existing = byBroadcast.get(broadcastService);
  if (existing) return existing;
  const created: SharedBotStatesReader = createSharedServiceRead({
    keyOf: () => BOT_GROUP_STATE_CHANNEL,
    fetch: () => botsService.getBotStates(),
    subscribe: (onEvent) =>
      broadcastService.onMessage((message) => {
        if (message.channel === BOT_GROUP_STATE_CHANNEL) onEvent();
      }),
  });
  byBroadcast.set(broadcastService, created);
  return created;
}

export function useBotGroupTask(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const { botsService, broadcastService } = useServices();
  const [context, setContext] = useState<BotContextState | null>(null);
  const [provider, setProvider] = useState<FeishuBotProvider>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    setContext(null);
    setProvider(undefined);
    // 草稿没有任务，不读取也不订阅群状态。
    if (!taskId) return;
    const reader = getSharedBotStatesReader(botsService, broadcastService);
    const refresh = async () => {
      const requested = ++revision;
      try {
        const states = await reader.read();
        if (disposed || revision !== requested) return;
        const nextContext =
          states.find(
            (state) =>
              (state.group?.taskWorkspaces?.[taskId]?.workspaceIdentity?.trim() ||
                state.group?.taskWorkspaces?.[taskId]?.workspacePath ||
                state.workspaceIdentity?.trim() ||
                state.workspacePath) === workspaceKey && state.group?.taskIds.includes(taskId),
          ) ?? null;
        setContext(nextContext);
        const savedProvider = Object.values(nextContext?.group?.inputs ?? {})[0]?.source.provider;
        setProvider(savedProvider);
        if (nextContext && !savedProvider) {
          // 首次准备还没有 accepted source，渠道名称取当前机器人配置，不默认猜作飞书。
          const config = await botsService.getConfig();
          if (disposed || revision !== requested) return;
          const configured = config.bots.find((bot) => bot.id === nextContext.botId)?.provider;
          setProvider(configured && isFeishuBotProvider(configured) ? configured : undefined);
        }
      } catch (error) {
        if (!disposed) logger.warn("读取群任务同步状态失败", { error: String(error) });
      }
    };
    // 先订阅再读取：读取器只在有订阅者期间缓存结果。
    const subscription = reader.onDidChange(() => void refresh());
    void refresh();
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [botsService, broadcastService, taskId, workspaceKey]);
  const retry = useCallback(
    async (deliveryId: string) => {
      if (!context?.group || !botsService.resendGroupResult) return;
      setBusyId(deliveryId);
      try {
        const result = await botsService.resendGroupResult({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          deliveryId,
        });
        setContext((current) =>
          current?.group &&
          current.botId === context.botId &&
          current.group.chatId === context.group!.chatId &&
          current.group.threadId === context.group!.threadId
            ? {
                ...current,
                group: {
                  ...current.group,
                  deliveries: { ...current.group.deliveries, [result.id]: result },
                },
              }
            : current,
        );
      } catch (error) {
        logger.warn("重发群结果失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context],
  );
  const reconcile = useCallback(
    async (deliveryId: string, received: boolean) => {
      if (!context?.group || !botsService.reconcileGroupResult) return;
      setBusyId(deliveryId);
      try {
        const result = await botsService.reconcileGroupResult({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          deliveryId,
          received,
        });
        setContext((current) =>
          current?.group &&
          current.botId === context.botId &&
          current.group.chatId === context.group!.chatId &&
          current.group.threadId === context.group!.threadId
            ? {
                ...current,
                group: {
                  ...current.group,
                  deliveries: { ...current.group.deliveries, [result.id]: result },
                },
              }
            : current,
        );
      } catch (error) {
        logger.warn("核对群结果失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context],
  );
  const retryPreparation = useCallback(
    async (messageId: string) => {
      if (!context?.group?.threadId || !taskId || !botsService.retryTopicPreparation) return;
      setBusyId(messageId);
      try {
        await botsService.retryTopicPreparation({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          taskId,
          workspacePath,
          workspaceIdentity,
          messageId,
        });
      } catch (error) {
        logger.warn("重试话题材料失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context, taskId, workspacePath, workspaceIdentity],
  );
  return { context, provider, busyId, retry, reconcile, retryPreparation };
}
