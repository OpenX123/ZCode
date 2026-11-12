import type { Root as ReactRoot } from "react-dom/client";
import { MobileRemoteApp } from "./MobileRemoteApp.js";
import { installMobileViewport } from "./viewport.js";

export function bootstrapMobileRemote(root: ReactRoot): void {
  document.title = "YCode";
  document.documentElement.dataset.zcodeMobileRemote = "true";
  const disposeViewport = installMobileViewport(document.getElementById("root")!);
  if (import.meta.hot) import.meta.hot.dispose(disposeViewport);
  root.render(<MobileRemoteApp />);
}
