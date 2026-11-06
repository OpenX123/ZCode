import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export function useExternalEngineService(workspaceIdentity?: string) {
  const services = useOptionalServices();
  return isRemoteWorkspaceIdentity(workspaceIdentity ?? "")
    ? undefined
    : services?.externalEngineService;
}

/** UI 只经服务访问器取得的引擎服务句柄类型，不直接依赖服务实现包。 */
export type ExternalEngineServiceHandle = NonNullable<ReturnType<typeof useExternalEngineService>>;
