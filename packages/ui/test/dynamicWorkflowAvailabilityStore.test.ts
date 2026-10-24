import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISettingService } from "@zcode/services";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

afterEach(resetDynamicWorkflowAvailabilityStoreForTests);
function settings(mode?: "disabled" | "onDemand" | "alwaysOn") {
  return { get: vi.fn(async () => ({ dynamicWorkflowMode: mode })) } as unknown as ISettingService;
}
describe("本地动态工作流", () => {
  it("H05 缺省 onDemand，既不需要账号也不调用远端配置", async () => {
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(settings());
    expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
      mode: "onDemand",
      enabled: true,
      source: "default",
    });
  });
  it.each(["disabled", "onDemand", "alwaysOn"] as const)("用户选择 %s 始终生效", async (mode) => {
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(settings(mode));
    expect(useDynamicWorkflowAvailabilityStore.getState().config?.mode).toBe(mode);
  });
  it("并发加载共享一次读取，设置改变后能重新加载", async () => {
    const service = settings();
    const { ensureLoaded, reload } = useDynamicWorkflowAvailabilityStore.getState();
    await Promise.all([ensureLoaded(service), ensureLoaded(service)]);
    expect(service.get).toHaveBeenCalledTimes(1);
    vi.mocked(service.get).mockResolvedValue({ dynamicWorkflowMode: "disabled" } as Awaited<
      ReturnType<ISettingService["get"]>
    >);
    await reload(service);
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(false);
  });
});
