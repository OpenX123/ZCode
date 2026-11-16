import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

async function createProviderFixture(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  tempHomes.push(home);
  process.env.HOME = home;
  const filePath = join(home, "zcode-builtin.json");
  // 修复原因：只传 {} 会让后台 Provider 初始化读取 undefined 路径并写出错误日志。
  // 使用当前 Release 合同的空配置，让装配测试独立于真实用户配置和发布文件。
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
    "utf8",
  );
  return filePath;
}

describe("退役云分享后的本地服务装配", () => {
  beforeEach(() => {
    // 保留真实日志输出，同时让后台初始化错误也能使测试失败。
    vi.spyOn(console, "error");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("装配不得请求官方业务服务"));
  });

  afterEach(async () => {
    try {
      for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true });
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("本地 Host 保留模型视图，不注册云发布或账号遥测 loader", async () => {
    const zcodeBuiltinProviderConfigFilePath = await createProviderFixture(
      "zcode-conversation-share-",
    );
    const [nodeModule, servicesModule] = await Promise.all([
      import("@zcode/services/node"),
      import("@zcode/services"),
    ]);

    const services = nodeModule.createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "desktop-local",
    });
    try {
      await expect(
        services.get(servicesModule.IModelSelectionService).getView(),
      ).resolves.toMatchObject({
        providers: [],
      });
      expect(
        services.getOptional(servicesModule.IProviderProvisioningTargetService),
      ).toBeUndefined();
      const registerChannel = vi.fn();
      services.exposeOnChannelServer({ registerChannel });
      expect(registerChannel.mock.calls.map(([name]) => name)).not.toContain("conversation-share");
      expect(registerChannel.mock.calls.map(([name]) => name)).not.toContain("telemetry");
      expect(nodeModule).not.toHaveProperty("createTelemetryUserIdLoader");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      // 修复原因：同步 dispose 后删 HOME，会让尚未收口的初始化/释放任务晚到写日志，
      // 与 Vitest worker 关闭日志 RPC 竞争；先等待服务释放，再由 afterEach 清理目录。
      await nodeModule.disposeServiceResourcesAndWait(services);
    }
  });

  it("desktop-attached-remote 保留模型视图与 Provisioning target 权威差异，不注册云发布", async () => {
    const zcodeBuiltinProviderConfigFilePath = await createProviderFixture(
      "zcode-conversation-share-remote-",
    );
    const [nodeModule, servicesModule] = await Promise.all([
      import("@zcode/services/node"),
      import("@zcode/services"),
    ]);

    const services = nodeModule.createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "desktop-attached-remote",
    });
    try {
      await expect(
        services.get(servicesModule.IModelSelectionService).getView(),
      ).resolves.toMatchObject({
        providers: [],
      });
      expect(services.get(servicesModule.IProviderProvisioningTargetService).apply).toBeTypeOf(
        "function",
      );
      const registerChannel = vi.fn();
      services.exposeOnChannelServer({ registerChannel });
      expect(registerChannel.mock.calls.map(([name]) => name)).not.toContain("conversation-share");
      expect(registerChannel.mock.calls.map(([name]) => name)).not.toContain("telemetry");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await nodeModule.disposeServiceResourcesAndWait(services);
    }
  });
});
