import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export {
  nextEngineConfigRestoreStep,
  useEngineConfigMemory,
  type EngineConfigMemory,
  type EngineConfigMemoryParams,
  type EngineConfigRestoreStep,
} from "./useEngineConfigMemory.js";

export function useExternalEngineService(workspaceIdentity?: string) {
  const services = useOptionalServices();
  return isRemoteWorkspaceIdentity(workspaceIdentity ?? "")
    ? undefined
    : services?.externalEngineService;
}
