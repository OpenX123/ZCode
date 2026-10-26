import { describe, expect, it, vi } from "vitest";
import { IExternalEngineService } from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

describe("外部引擎 RPC 能力", () => {
  it("远端及未声明能力的 scope 不创建惰性代理", () => {
    const getChannel = vi.fn(() => ({ call: vi.fn(), listen: vi.fn() }));
    const services = new RemoteServiceAccess({ getChannel });
    expect(services.externalEngineService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(IExternalEngineService.channelName);
  });

  it("本地桌面显式能力通过真实频道调用安装接口", async () => {
    const call = vi.fn(async () => ({ ready: false }));
    const getChannel = vi.fn(() => ({ call, listen: vi.fn() }));
    const services = new RemoteServiceAccess({ getChannel }, { externalEngineService: true });
    await services.externalEngineService!.installAdapter("codex");
    expect(getChannel).toHaveBeenCalledWith(IExternalEngineService.channelName);
    expect(call).toHaveBeenCalledWith("installAdapter", ["codex"]);
  });
});
