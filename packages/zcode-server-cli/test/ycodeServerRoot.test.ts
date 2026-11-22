import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServerLayout, stablePathId, stableServerRootId } from "../src/runtime/paths.js";

describe("server root after ~/.zcode -> ~/.ycode migration", () => {
  const home = resolve("/home/tester");

  it("keeps the service identity of the legacy root so re-registration replaces the old unit", () => {
    const legacyRoot = join(home, ".zcode", "server");
    const nextRoot = join(home, ".ycode", "server");
    expect(stableServerRootId(nextRoot)).toBe(stablePathId(legacyRoot));
    expect(stableServerRootId(legacyRoot)).toBe(stablePathId(legacyRoot));
    const custom = join(home, "custom-root");
    expect(stableServerRootId(custom)).toBe(stablePathId(custom));
  });

  it("infers the data base dir from both standard roots", () => {
    expect(resolveServerLayout(join(home, ".ycode", "server")).dataBaseDir).toBe(home);
    expect(resolveServerLayout(join(home, ".zcode", "server")).dataBaseDir).toBe(home);
  });
});
