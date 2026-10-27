// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://ycode.example/"}
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { roots, connectViaWebSocket, renderWorkspace } = vi.hoisted(() => ({
  roots: [] as Root[],
  connectViaWebSocket: vi.fn(),
  renderWorkspace: vi.fn((_props: Record<string, unknown>) => "web-server-workspace"),
}));

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

vi.mock("@zcode/client", () => ({ connectViaWebSocket }));
vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => children,
  Root: renderWorkspace,
  ZCodeIntlProvider: ({ children }: { children: ReactNode }) => children,
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
}));

const services = { settingService: {}, broadcastService: {} };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      workspaces: [{ path: "/server/workspace", workspaceIdentity: "server-workspace" }],
    }),
  });
  connectViaWebSocket.mockResolvedValue(services);
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function bootstrap(path: string) {
  window.history.replaceState(
    null,
    "",
    `${path}?state=legacy-state&authCode=legacy-code&code=legacy-code&error=access_denied`,
  );
  await act(async () => {
    await import("@web/main.js");
  });
}

// 官方账号回调与云分享已退役；保留真实入口断言，防止旧链接重新启用账号服务。
describe("独立 Web 入口忽略退役的 OAuth 回调", () => {
  it.each(["/", "/share/callback", "/cn/share/callback", "/remote/v4", "/remote/v4/"])(
    "%s 携带旧认证参数仍只连接同源 Web + Server",
    async (path) => {
      await bootstrap(path);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/server-info", { cache: "no-store" });
      expect(connectViaWebSocket).toHaveBeenCalledTimes(1);
      expect(connectViaWebSocket).toHaveBeenCalledWith("wss://ycode.example/ws", {
        onClose: expect.any(Function),
      });
      expect(document.body.textContent).toBe("web-server-workspace");
      expect(document.title).toBe("YCode - Web + Server");
      expect(renderWorkspace.mock.calls[0]?.[0]).toMatchObject({
        services,
        initialWorkspaceAbsPath: "/server/workspace",
        initialWorkspaceIdentity: "server-workspace",
        allowRemoteWorkspace: false,
      });
    },
  );

  it("同源服务连接失败时展示重试入口，不转入已退役认证页", async () => {
    connectViaWebSocket.mockRejectedValueOnce(new Error("server unavailable"));

    await bootstrap("/share/callback");

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("server unavailable");
    expect(document.querySelector("button")?.textContent).toBe("重新连接");
    expect(renderWorkspace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
