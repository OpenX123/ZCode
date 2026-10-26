import { describe, expect, it, vi } from "vitest";
import type { ExternalEngineStatus } from "@zcode/shared/external-engine";
import { installIfUserConfirmed } from "./contract.example.js";
import type { IExternalEngineService } from "./contract.js";

const notInstalled: ExternalEngineStatus = {
  engine: "claude-code",
  adapter: { installed: false },
  officialCli: { found: true },
  auth: { state: "loggedIn" },
  ready: false,
};

function createService(): IExternalEngineService {
  return {
    getStatus: vi.fn(async () => notInstalled),
    listStatuses: vi.fn(async () => [notInstalled]),
    installAdapter: vi.fn(async () => ({
      ...notInstalled,
      adapter: { installed: true, version: "0.95.0", source: "managed" as const },
      ready: true,
    })),
    onStatusChanged: () => ({ dispose() {} }),
  };
}

describe("IExternalEngineService 契约", () => {
  it("未经用户确认不安装 adapter", async () => {
    const service = createService();
    await expect(installIfUserConfirmed(service, "claude-code", false)).resolves.toBe(notInstalled);
    expect(service.installAdapter).not.toHaveBeenCalled();
  });

  it("用户确认后安装并返回就绪状态", async () => {
    const service = createService();
    const status = await installIfUserConfirmed(service, "claude-code", true);
    expect(service.installAdapter).toHaveBeenCalledWith("claude-code");
    expect(status.ready).toBe(true);
  });
});
