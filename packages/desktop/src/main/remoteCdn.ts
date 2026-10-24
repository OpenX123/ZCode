/** SSH 资源默认来自源码构建的随包目录，仅允许用户显式配置镜像。 */
export interface ResolveRemoteCdnOptions {
  overrideBaseUrl?: string;
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const baseUrl = options.overrideBaseUrl?.trim().replace(/\/+$/, "");
  return baseUrl ? [baseUrl] : [];
}
