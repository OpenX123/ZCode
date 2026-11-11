import { connectViaWebSocket } from "@zcode/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  installDocumentHiddenMotionPause,
  setStreamClientId,
} from "@zcode/ui";
import type { ServerRemoteInfo } from "@zcode/shared";
import { createWebPlatform } from "./platform/webPlatform.js";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
}

installDocumentHiddenMotionPause();
setStreamClientId(crypto.randomUUID());
const root = createRoot(document.getElementById("root")!);

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}
async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}
async function bootstrapWebApp(): Promise<void> {
  try {
    const bootstrap = await resolveWebBootstrap();
    const services = await connectViaWebSocket(bootstrap.wsUrl, { onClose: () => {} });
    document.title = "YCode - Web + Server";
    root.render(
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          <Root
            services={services}
            platform={createWebPlatform()}
            initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
            initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    root.render(
      <main role="alert">
        <h1>连接服务失败</h1>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        <button onClick={() => window.location.reload()}>重新连接</button>
      </main>,
    );
  }
}
// 手机远控网页由自托管中继在 /m/ 下托管（vite --base /m/ 构建），走端到端加密直连的独立启动流程。
if (import.meta.env.BASE_URL === "/m/") {
  void import("./mobile/index.js").then((module) => module.bootstrapMobileRemote(root));
} else {
  void bootstrapWebApp();
}
