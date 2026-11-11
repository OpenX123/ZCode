import { Lexer } from "marked";
import { createProjectId } from "../deps.js";
import type { ProjectId } from "../deps.js";

/** 只清理派生标题里的技能引用，原始提示词和技能执行输入保持不变。 */
export function readableTitleInput(input: string): string {
  const seen = new Set<string>();
  const skill = (label: string, path: string) => {
    const identity = `${label}:${path}`;
    if (seen.has(identity)) return "";
    seen.add(identity);
    return label;
  };
  const readable = Lexer.lexInline(input).map((token) => {
    if (token.type === "link" && /^\$[\w:.-]+$/.test(token.text)) return skill(token.text, token.href);
    // 未闭合链接必须有精确文件名边界，不能把随后中文需求吞进路径。
    // codespan 等 Markdown 结构保持原样，普通链接也不参与清理。
    if (token.type !== "text") return token.raw;
    return token.raw.replace(
      /\[(\$[\w:.-]+)\]\(<?((?:\/|[A-Za-z]:[\\/])[^\r\n]*?[/\\]SKILL\.md)(?![A-Za-z0-9_.-])(?:>\)?|\))?/g,
      (_match, label: string, path: string) => skill(label, path),
    );
  }).join("");
  return readable.trim().replace(/\s+/g, " ");
}

export function titleFromInput(input: string): string {
  const compact = readableTitleInput(input);
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
