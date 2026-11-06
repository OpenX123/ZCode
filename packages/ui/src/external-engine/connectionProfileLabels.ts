import type {
  ExternalEngineConnectionView,
  ExternalEngineConnectionsView,
  ExternalEngineStatus,
  ExternalSessionEngine,
} from "@zcode/shared/external-engine";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

/** 选择器与列表只展示未隐藏的配置；内置配置排在用户配置之前（视图已按此顺序给出）。 */
export function visibleEngineConnectionProfiles(
  connections: ExternalEngineConnectionsView | null | undefined,
  engine: ExternalSessionEngine,
): ExternalEngineConnectionView[] {
  return (connections?.profiles ?? []).filter(
    (profile) => profile.engine === engine && !profile.hidden,
  );
}

export function findEngineConnectionView(
  connections: ExternalEngineConnectionsView | null | undefined,
  engine: ExternalSessionEngine,
  id: string | undefined,
): ExternalEngineConnectionView | undefined {
  return id
    ? connections?.profiles.find((profile) => profile.engine === engine && profile.id === id)
    : undefined;
}

export function engineConnectionModeLabel(
  intl: Intl,
  mode: ExternalEngineConnectionView["mode"],
): string {
  return intl.formatMessage({ id: `engine.profile.mode.${mode}` });
}

/** 名称缺省按方式与网关域名生成；内置配置使用固定名称。 */
export function engineConnectionProfileName(
  intl: Intl,
  profile: ExternalEngineConnectionView,
): string {
  if (profile.name) return profile.name;
  const mode = engineConnectionModeLabel(intl, profile.mode);
  return profile.gatewayHost ? `${mode} · ${profile.gatewayHost}` : mode;
}

/** 列表中的网关说明：API Key 用配置地址，沿用 CLI 用 Host 检测到的网关。 */
export function engineConnectionRouteLabel(
  intl: Intl,
  profile: ExternalEngineConnectionView,
  status: ExternalEngineStatus | undefined,
): string | undefined {
  if (profile.mode === "apiKey")
    return profile.gatewayHost
      ? intl.formatMessage({ id: "engine.profile.gateway" }, { host: profile.gatewayHost })
      : intl.formatMessage({ id: `engine.profile.officialApiKey.${profile.engine}` });
  if (profile.mode === "inherit" && status?.inheritedGatewayHost)
    return intl.formatMessage(
      { id: "engine.profile.gateway" },
      { host: status.inheritedGatewayHost },
    );
  return undefined;
}

/** 引擎标题行的身份说明：网关优先，避免网关用户看到「未登录」。 */
export function engineAuthSummary(intl: Intl, status: ExternalEngineStatus): string {
  if (status.auth.gatewayHost)
    return intl.formatMessage({ id: "engine.profile.gateway" }, { host: status.auth.gatewayHost });
  if (status.auth.label === "apiKey")
    return intl.formatMessage({
      id:
        status.auth.state === "loggedIn"
          ? `engine.profile.officialApiKey.${status.engine}`
          : "engine.profile.missingKey",
    });
  const state = intl.formatMessage({ id: `engine.auth.${status.auth.state}` });
  return status.auth.label === "subscription"
    ? `${state} · ${intl.formatMessage({ id: "engine.authLabel.subscription" })}`
    : state;
}
