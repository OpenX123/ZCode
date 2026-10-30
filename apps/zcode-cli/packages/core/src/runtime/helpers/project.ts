import { Lexer } from "marked";
import { createProjectId } from "../deps.js";
import type { ProjectId } from "../deps.js";

export function titleFromInput(input: string): string {
  // 技能引用携带完整文件路径，直接截断会让标题只剩路径；先取链接标签，
  // 再截断派生标题。复用 Markdown 解析器以保留代码和不完整链接，原始输入不变。
  const readable = Lexer.lexInline(input)
    .map((token) => (token.type === "link" && token.text.startsWith("$") ? token.text : token.raw))
    .join("");
  const compact = readable.trim().replace(/\s+/g, " ");
  if (!compact) return "Untitled session";
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(slugify(directory).slice(0, 80) || "default");
}
