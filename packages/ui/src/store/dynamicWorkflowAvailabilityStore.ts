import { create } from "zustand";
import {
  resolveDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { logger } from "@/logger.js";

// 动态工作流可用性是本地设置的只读投影：默认 onDemand，用户选择优先。
// Root 统一加载，自动化页与运行面板只订阅；切换 service 后重新读取对应设置。

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** loading 期间恒为 false：未知即不提供，入口宁可晚半拍出现也不闪一下再收起。 */
  readonly enabled: boolean;
  /**
   * 未就绪或取数失败时为 null；offeredMode 是内置默认模式，mode 是生效模式。
   */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** 首次取数；同一个 service 出过结果后是 no-op，并发调用共用同一次请求。 */
  ensureLoaded(service: ISettingService): Promise<void>;
  /** 重新读取本地设置。 */
  refresh(service: ISettingService): Promise<void>;
  /** Host 同步用户选择后，重新读取本地生效值。 */
  reload(service: ISettingService): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

let inFlight: Promise<void> | null = null;
/** 已经出过结果（成功或失败）的 service 实例；同一实例不再重复请求。 */
let settledService: ISettingService | null = null;

type PublishSnapshot = (snapshot: DynamicWorkflowAvailabilitySnapshot) => void;

async function loadDynamicWorkflowConfig(
  service: ISettingService,
  publish: PublishSnapshot,
): Promise<void> {
  try {
    const config = resolveDynamicWorkflowClientConfig({
      userMode: (await service.get()).dynamicWorkflowMode,
    });
    publish({ status: "ready", enabled: config.enabled === true, config });
  } catch (error) {
    logger.warn(
      "[dynamic-workflow] 本地设置读取失败，暂不提供工作流入口",
      error instanceof Error ? error.message : String(error),
    );
    publish({ status: "ready", enabled: false, config: null });
  } finally {
    settledService = service;
  }
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(service): Promise<void> {
      if (settledService === service) return Promise.resolve();
      if (inFlight) {
        // 在途的可能属于旧 service：排在它后面重新判断，避免并发读取覆盖新设置。
        // 若在途的就是这一份，那时 settledService 已等于它，递归会立即命中上面的 no-op。
        return inFlight.then(() => get().ensureLoaded(service));
      }
      const run = loadDynamicWorkflowConfig(service, set).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },

    refresh(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, set);
    },

    reload(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, set);
    },
  }),
);

/** 测试用：清掉快照与「已出结果」闩。 */
export function resetDynamicWorkflowAvailabilityStoreForTests(): void {
  inFlight = null;
  settledService = null;
  useDynamicWorkflowAvailabilityStore.setState({ ...INITIAL_SNAPSHOT });
}
