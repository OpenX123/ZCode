import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export function useExternalEngineService(workspaceIdentity?: string) {
  const services = useOptionalServices();
  return isRemoteWorkspaceIdentity(workspaceIdentity ?? "")
    ? undefined
    : services?.externalEngineService;
}
