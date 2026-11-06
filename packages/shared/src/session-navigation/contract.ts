import { z } from "zod";

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x1f) return false;
  }
  return true;
}

/** 只定位已有会话，不表达打开目录、新建会话或连接未知设备的授权。 */
export const sessionLocatorSchema = z
  .object({
    taskId: z
      .string()
      .min(1)
      .max(512)
      .refine(hasNoControlCharacters, "must not contain control characters"),
    workspacePath: z
      .string()
      .min(1)
      .max(32768)
      .refine(hasNoControlCharacters, "must not contain control characters"),
    workspaceIdentity: z.string().trim().min(1).max(32768).optional(),
    sourceServerId: z.string().min(1).max(512).optional(),
  })
  .strict();
export type SessionLocator = z.infer<typeof sessionLocatorSchema>;

/** 纯编码；链接不包含临时连接 ID、凭据或正文。 */
export function buildSessionDeepLink(locator: SessionLocator): string {
  const value = sessionLocatorSchema.parse(locator);
  const url = new URL("zcode://session/open");
  url.searchParams.set("taskId", value.taskId);
  url.searchParams.set("path", value.workspacePath);
  if (value.workspaceIdentity) url.searchParams.set("identity", value.workspaceIdentity);
  if (value.sourceServerId) url.searchParams.set("source", value.sourceServerId);
  return url.toString();
}

/** 外部输入校验失败返回 null；不探测文件、不连接设备、不产生副作用。 */
export function parseSessionDeepLink(input: string): SessionLocator | null {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "zcode:" ||
      url.hostname !== "session" ||
      url.pathname !== "/open" ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      return null;
    const keys = new Set(["taskId", "path", "identity", "source"]);
    for (const key of url.searchParams.keys()) {
      if (!keys.has(key) || url.searchParams.getAll(key).length !== 1) return null;
    }
    const result = sessionLocatorSchema.safeParse({
      taskId: url.searchParams.get("taskId"),
      workspacePath: url.searchParams.get("path"),
      ...(url.searchParams.has("identity")
        ? { workspaceIdentity: url.searchParams.get("identity") }
        : {}),
      ...(url.searchParams.has("source") ? { sourceServerId: url.searchParams.get("source") } : {}),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
