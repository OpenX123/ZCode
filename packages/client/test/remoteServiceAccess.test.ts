import { describe, expect, it, vi } from "vitest";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { IProviderSettingsService, ISourceServerManagementService } from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

const channel: IChannel = {
  call: vi.fn(),
  listen: vi.fn(),
};

describe("RemoteServiceAccess", () => {
  it("Provider 设置经保留频道 RPC 读取，不构造已退役的 client-config", async () => {
    const view = { revision: 1, providerTemplates: [], providerOrder: [], providers: [] };
    const call = vi.fn(async () => view);
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });
    expect(await services.providerSettingsService.getView()).toEqual(view);
    expect(requested).toContain(IProviderSettingsService.channelName);
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["getView", []]);
    expect(requested).not.toContain("client-config");
    expect(services).not.toHaveProperty("clientConfigService");
  });
});

describe("RemoteServiceAccess optional channels", () => {
  it("does not construct a Source management proxy for scopes that do not publish it", () => {
    const getChannel = vi.fn(() => channel);
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      sourceServerManagementService: false,
    });

    expect(services.sourceServerManagementService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ISourceServerManagementService.channelName);
  });
});

it("MRO02：窗口目录只由显式能力创建，原工作区 project 频道保留", async () => {
  const calls: string[] = [];
  const getChannel = vi.fn((name: string) => ({
    call: async () => {
      calls.push(name);
      return name === "window-project-changes" ? { version: 1 } : { projects: [], tasks: [] };
    },
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel });
  expect(legacy.windowProjectDirectory).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith("window-project");
  const services = new RemoteServiceAccess({ getChannel }, { windowProjectDirectory: true });
  expect(services.windowProjectDirectory).toBeDefined();
  await services.windowProjectDirectory!.changesService.getCapabilities();
  await services.windowProjectDirectory!.projectService.readTree();
  await services.projectService.readTree();
  expect(calls).toEqual(["window-project-changes", "window-project", "project"]);
});
