import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExternalEngineConnectionCommand,
  ExternalEngineConnectionUpdate,
  ExternalEngineConnectionsView,
} from "@zcode/shared/external-engine";
import { logger } from "@/logger.js";
import { createSharedServiceRead, type SharedServiceRead } from "@/store/serviceAuthorityKey.js";
import type { ExternalEngineServiceHandle } from "./useExternalEngineService.js";

type SharedConnectionProfilesReader = SharedServiceRead<
  void,
  ExternalEngineConnectionsView,
  ExternalEngineConnectionsView
>;

const CONNECTION_PROFILES_KEY = "connection-profiles";
const sharedConnectionProfilesReaders = new WeakMap<
  ExternalEngineServiceHandle,
  SharedConnectionProfilesReader
>();

/**
 * 连接配置的窗口级共享读取（P5，docs/desktop/engine-performance-1.1-spec.md「窗口级只读数据共享」）。
 * 修复原因：每个外部引擎会话面板的 useEngineConnectionControl 各读一次 getConnectionProfiles（窗口打开
 * 实测 9 次）。按服务实例共享：只读一次、只订阅一次变更广播；广播负载即完整视图，直接作为最新值。
 */
function getSharedConnectionProfilesReader(
  service: ExternalEngineServiceHandle,
): SharedConnectionProfilesReader {
  const existing = sharedConnectionProfilesReaders.get(service);
  if (existing) return existing;
  const created: SharedConnectionProfilesReader = createSharedServiceRead({
    keyOf: () => CONNECTION_PROFILES_KEY,
    fetch: () =>
      service.getConnectionProfiles
        ? service.getConnectionProfiles()
        : Promise.reject(new Error("external_engine_connection_profiles_unavailable")),
    subscribe: (onEvent) => service.onConnectionProfilesChanged?.(onEvent),
    valueOfEvent: (value) => ({ key: CONNECTION_PROFILES_KEY, value }),
  });
  sharedConnectionProfilesReaders.set(service, created);
  return created;
}

/**
 * 连接配置的只读视图：Host 是唯一写者，这里只缓存最近一次视图并订阅本 Host 的变更广播。
 * 写入统一走 updateConnectionProfiles 命令，成功后以 Host 返回的视图为准，不做乐观改写。
 * 同一服务实例上的多个实例经共享读取器合并读取与订阅；refresh 是显式重读，不读共享缓存。
 */
export function useEngineConnectionProfiles(service: ExternalEngineServiceHandle | undefined) {
  const [connections, setConnections] = useState<ExternalEngineConnectionsView | null>(null);
  const [loading, setLoading] = useState(Boolean(service?.getConnectionProfiles));
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const read = useCallback(
    async (fresh: boolean) => {
      if (!service?.getConnectionProfiles) return;
      const current = ++generation.current;
      setLoading(true);
      try {
        const value = await getSharedConnectionProfilesReader(service).read(
          undefined,
          fresh ? { fresh: true } : undefined,
        );
        if (current !== generation.current) return;
        setConnections(value);
        setFailed(false);
      } catch (error) {
        if (current !== generation.current) return;
        setFailed(true);
        logger.warn("[external-engine] 读取连接配置失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [service],
  );
  const refresh = useCallback(() => read(true), [read]);
  useEffect(() => {
    if (!service) return;
    // 先订阅再读取：读取器只在有订阅者期间缓存结果。
    const subscription = getSharedConnectionProfilesReader(service).onDidChange((value) => {
      // 广播晚于在途读取时以广播为准，并作废尚未返回的旧读取。
      generation.current += 1;
      setConnections(value);
      setLoading(false);
      setFailed(false);
    });
    void read(false);
    return () => {
      generation.current += 1;
      subscription.dispose();
    };
  }, [service, read]);
  const update = useCallback(
    async (command: ExternalEngineConnectionCommand): Promise<ExternalEngineConnectionUpdate> => {
      if (!service?.updateConnectionProfiles) throw new Error("external_engine_connection_invalid");
      const result = await service.updateConnectionProfiles(command);
      generation.current += 1;
      setConnections(result.connections);
      setFailed(false);
      return result;
    },
    [service],
  );
  return { connections, loading, failed, refresh, update };
}
