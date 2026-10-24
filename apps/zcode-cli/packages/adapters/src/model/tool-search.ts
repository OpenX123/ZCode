import { TOOL_SEARCH_BETA, type ToolSearchCapability } from "@zcode/contracts";

export function resolveToolSearchCapability(apiType: string): ToolSearchCapability {
  const protocolSupported = apiType === "anthropic-messages";
  return Object.freeze({ protocolSupported, defaultEnabled: false });
}

export function toolSearchHeaders(headers: Record<string, string> | undefined, enabled?: boolean) {
  if (!enabled) return headers;
  const result = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  result[key] = [
    ...new Set([
      ...(result[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      TOOL_SEARCH_BETA,
    ]),
  ].join(",");
  return result;
}
