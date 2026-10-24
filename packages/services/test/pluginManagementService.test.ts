import { describe, expect, it, vi } from "vitest";
import { createPluginManagementService } from "../src/plugins/pluginManagementService.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

describe("独立插件管理转发", () => {
  it("原样转发安装返回与普通工作区参数", async () => {
    const result = { installedPlugins: [], diagnostics: [] };
    const installPlugin = vi.fn().mockResolvedValue(result);
    const service = createPluginManagementService({
      zcodeAgentService: { installPlugin } as unknown as IZCodeAgentService,
    });
    const params = {
      workspacePath: "/private/work",
      workspaceIdentity: "remote-workspace",
      remoteSessionId: "remote-session",
      pluginName: "demo",
      marketplace: "market",
    };
    expect(await service.installPlugin(params)).toBe(result);
    expect(installPlugin.mock.calls[0][0]).toBe(params);
    expect(installPlugin).toHaveBeenCalledWith({
      workspacePath: "/private/work",
      workspaceIdentity: "remote-workspace",
      remoteSessionId: "remote-session",
      pluginName: "demo",
      marketplace: "market",
    });
  });
  it("原样保留取消异常和操作取消协议", async () => {
    const error = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const cancelPluginOperation = vi.fn().mockResolvedValue({ cancelled: true, operationId: "op" });
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn().mockRejectedValue(error),
        cancelPluginOperation,
      } as unknown as IZCodeAgentService,
    });
    await expect(
      service.installPlugin({ workspacePath: "/work", pluginName: "demo", marketplace: "market" }),
    ).rejects.toBe(error);
    await expect(service.cancelPluginOperation({ operationId: "op" })).resolves.toEqual({
      cancelled: true,
      operationId: "op",
    });
    expect(cancelPluginOperation).toHaveBeenCalledWith({ operationId: "op" });
  });
});

it("转发不可枚举的 RPC 方法与原始插件参数", async () => {
  const listPlugins = vi.fn(async () => ({ plugins: [], diagnostics: [] }));
  const installPlugin = vi.fn(async () => ({ installedPlugins: [], diagnostics: [] }));
  const remote = new Proxy(
    {},
    { get: (_target, key) => ({ listPlugins, installPlugin })[key as "listPlugins"] },
  );
  const service = createPluginManagementService({ zcodeAgentService: remote as never });
  const params = { workspacePath: "/workspace", pluginName: "demo", marketplace: "market" };
  await service.listPlugins(params);
  await service.installPlugin(params);
  expect(listPlugins).toHaveBeenCalledWith(params);
  expect(installPlugin).toHaveBeenCalledWith(params);
});
