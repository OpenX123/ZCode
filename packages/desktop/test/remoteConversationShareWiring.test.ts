import { describe, expect, it, vi } from "vitest";
import { IFileService, IZCodeSessionService, type IServiceAccessor } from "@zcode/services";
import { ChannelClient, ChannelServer, createQueuePair } from "@zcode/rpc";
import { createServerRemoteWorkspaceServiceCollection } from "@desktop/host/remoteWorkspaceServiceCollection.js";
import { REMOTE_WORKSPACE_RPC_CHANNELS } from "@desktop/host/remoteWorkspaceRpcContract.js";

function fixture() {
  const file = {
    path: "/remote/project/example.txt",
    content: "source file",
    offset: 0,
    bytesRead: 11,
    totalBytes: 11,
    truncated: false,
    isBinary: false,
  };
  const readTextFile = vi.fn<IFileService["readTextFile"]>(async () => file);
  const getImportedConversation = vi.fn(async () => ({ title: "本地保留的历史" }));
  const connectionServices = {
    ...Object.fromEntries(REMOTE_WORKSPACE_RPC_CHANNELS.map((key) => [key, {}])),
    fileService: { readTextFile },
    zcodeSessionService: { getImportedConversation },
  } as unknown as IServiceAccessor;
  return { connectionServices, readTextFile, getImportedConversation, file };
}

describe("退役云分享后的远端服务装配", () => {
  it.each(["ssh", "wsl", "docker", "server"] as const)(
    "%s 不发布云分享频道，文件和历史读取仍通过 Source RPC",
    async (targetKind) => {
      const f = fixture();
      const services = createServerRemoteWorkspaceServiceCollection({ ...f, targetKind });
      expect(services.get(IFileService)).toBe(f.connectionServices.fileService);
      expect(services.get(IZCodeSessionService)).toBe(f.connectionServices.zcodeSessionService);
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "remote-services");
      const client = new ChannelClient(clientProtocol);
      const registrations = vi.spyOn(server, "registerChannel");
      services.exposeOnChannelServer(server);
      try {
        expect(registrations.mock.calls.map(([name]) => name)).not.toContain("conversation-share");
        const file = { path: "/remote/project/example.txt" };
        await expect(
          client.getChannel(IFileService.channelName).call("readTextFile", [file]),
        ).resolves.toEqual(f.file);
        expect(f.readTextFile).toHaveBeenCalledWith(file);
        const history = { workspacePath: "/remote/project", contextId: "legacy-context" };
        await expect(
          client
            .getChannel(IZCodeSessionService.channelName)
            .call("getImportedConversation", [history]),
        ).resolves.toEqual({ title: "本地保留的历史" });
        expect(f.getImportedConversation).toHaveBeenCalledWith(history);
      } finally {
        client.dispose();
        server.dispose();
      }
    },
  );

  it("重新装配使用新 Source 文件服务，不保留旧连接", async () => {
    const old = fixture();
    const next = fixture();
    createServerRemoteWorkspaceServiceCollection({ ...old, targetKind: "ssh" });
    const current = createServerRemoteWorkspaceServiceCollection({ ...next, targetKind: "ssh" });
    await current.get(IFileService).readTextFile({ path: "/remote/project/example.txt" });
    expect(next.readTextFile).toHaveBeenCalledOnce();
    expect(old.readTextFile).not.toHaveBeenCalled();
  });
});
