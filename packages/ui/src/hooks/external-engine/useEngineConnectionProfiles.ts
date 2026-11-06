import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExternalEngineConnectionCommand,
  ExternalEngineConnectionUpdate,
  ExternalEngineConnectionsView,
} from "@zcode/shared/external-engine";
import { logger } from "@/logger.js";
import type { ExternalEngineServiceHandle } from "./useExternalEngineService.js";

/**
 * 连接配置的只读视图：Host 是唯一写者，这里只缓存最近一次视图并订阅本 Host 的变更广播。
 * 写入统一走 updateConnectionProfiles 命令，成功后以 Host 返回的视图为准，不做乐观改写。
 */
export function useEngineConnectionProfiles(service: ExternalEngineServiceHandle | undefined) {
  const [connections, setConnections] = useState<ExternalEngineConnectionsView | null>(null);
  const [loading, setLoading] = useState(Boolean(service?.getConnectionProfiles));
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!service?.getConnectionProfiles) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const value = await service.getConnectionProfiles();
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
  }, [service]);
  useEffect(() => {
    void refresh();
    const subscription = service?.onConnectionProfilesChanged?.((value) => {
      // 广播晚于在途读取时以广播为准，并作废尚未返回的旧读取。
      generation.current += 1;
      setConnections(value);
      setLoading(false);
      setFailed(false);
    });
    return () => {
      generation.current += 1;
      subscription?.dispose();
    };
  }, [service, refresh]);
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
