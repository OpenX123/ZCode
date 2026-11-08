import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotConfig, BotState } from "@zcode/shared";
import { getSharedBotStatesReader } from "@/hooks/useBotGroupTask.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface BoundGroupRow {
  chatId: string;
  name: string;
  enabled: boolean;
  topicCount: number;
}

export function projectBoundGroups(
  states: BotState[],
  botId: string,
  ownerId?: string,
): BoundGroupRow[] {
  if (!ownerId) return [];
  const groups = states.filter(
    (state) => state.botId === botId && state.group?.ownerId === ownerId,
  );
  return groups
    .filter((state) => !state.group!.threadId)
    .map(({ group }) => ({
      chatId: group!.chatId,
      name: group!.name,
      enabled: group!.enabled,
      topicCount: new Set(
        groups
          .filter((state) => state.group!.chatId === group!.chatId)
          .map((state) => state.group!.threadId)
          .filter(Boolean),
      ).size,
    }));
}

export function useBotBoundGroups(bot: BotConfig) {
  const { botsService, broadcastService } = useServices();
  const [states, setStates] = useState<BotState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  const savingRef = useRef(false);
  // P5：与会话面板共用同一 Bot 状态共享读取器（同服务实例只读一次、只订阅一次广播）。
  // 挂载与广播触发的读取可复用共享结果；手动刷新与保存后确认是显式重读（fresh）。
  const refresh = useCallback(
    async (fresh: boolean) => {
      const requested = ++revision.current;
      const next = await getSharedBotStatesReader(botsService, broadcastService).read(
        undefined,
        fresh ? { fresh: true } : undefined,
      );
      if (alive.current && requested === revision.current) {
        setStates(next);
        setLoading(false);
      }
      return next;
    },
    [botsService, broadcastService],
  );
  const load = useCallback(
    async (fresh: boolean) => {
      const requested = revision.current + 1;
      setError(null);
      try {
        await refresh(fresh);
      } catch (cause) {
        // 迟到的失败不能覆盖广播触发的新读取结果。
        if (!alive.current || requested !== revision.current) return;
        logger.warn("读取已绑定群聊失败", { error: String(cause) });
        setError("load");
        setLoading(false);
      }
    },
    [refresh],
  );
  const reload = useCallback(() => load(true), [load]);
  useEffect(() => {
    alive.current = true;
    // 先订阅再读取：读取器只在有订阅者期间缓存结果。
    const subscription = getSharedBotStatesReader(botsService, broadcastService).onDidChange(
      () => void load(false),
    );
    void load(false);
    return () => {
      alive.current = false;
      ++revision.current;
      subscription.dispose();
    };
  }, [botsService, broadcastService, load]);
  const toggle = useCallback(
    async (chatId: string, enabled: boolean) => {
      if (savingRef.current || !bot.enabled || !botsService.setGroupEnabled) return;
      savingRef.current = true;
      setSaving(chatId);
      setError(null);
      try {
        await botsService.setGroupEnabled({ botId: bot.id, chatId, enabled });
        const next = await refresh(true);
        // 旧接口可能返回成功但未改变授权，必须读取权威状态再确认。
        const actual = projectBoundGroups(next, bot.id, bot.providerUserId).find(
          (row) => row.chatId === chatId,
        );
        if (actual?.enabled !== enabled) throw new Error("Group authorization was not updated");
      } catch (cause) {
        if (alive.current) {
          logger.warn("保存群聊开关失败", { error: String(cause) });
          setError("save");
        }
      } finally {
        savingRef.current = false;
        if (alive.current) setSaving(null);
      }
    },
    [bot.enabled, bot.id, bot.providerUserId, botsService, refresh],
  );
  const rows = useMemo(
    () => projectBoundGroups(states, bot.id, bot.providerUserId),
    [states, bot.id, bot.providerUserId],
  );
  return {
    rows,
    loading,
    error,
    saving,
    reload,
    toggle,
    supported: Boolean(botsService.setGroupEnabled),
  };
}
