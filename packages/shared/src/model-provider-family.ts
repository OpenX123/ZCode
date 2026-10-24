import { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

/** 旧设置与历史模型标识的只读兼容类型，不影响普通 Provider 可用性。 */
export type ModelProviderFamilyId = "zai" | "bigmodel";
export type ProviderFamilyDomain = ModelProviderFamilyId;

const HISTORICAL_PROVIDER_FAMILIES = {
  zai: { id: "zai", label: "Z.ai" },
  bigmodel: { id: "bigmodel", label: "BigModel" },
} as const;

export function getModelProviderFamilySpec(familyId: ModelProviderFamilyId) {
  return HISTORICAL_PROVIDER_FAMILIES[familyId];
}

/** 仅用于旧会话模型标签，不能用此映射选择或启用模型。 */
export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  for (const familyId of ["zai", "bigmodel"] as const) {
    if (
      Object.entries(BUILTIN_MODEL_PROVIDER_IDS).some(
        ([key, id]) => key.startsWith(familyId) && id === providerId,
      )
    )
      return familyId;
  }
  return null;
}
