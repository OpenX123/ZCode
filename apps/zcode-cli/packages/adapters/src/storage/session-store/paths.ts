import { resolveYCodeDataRoot } from "@zcode/shared/ycode-data-root";
import { homedir } from "node:os";
import { join } from "node:path";

export function getDefaultSessionDbPath(): string {
  return join(resolveYCodeDataRoot(homedir()), "cli", "db", "db.sqlite");
}
