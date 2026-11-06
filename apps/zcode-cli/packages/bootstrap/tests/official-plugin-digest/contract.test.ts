import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliOfficialPluginDigestModule } from "../../src/app/official-plugin-digest/module.js";
import {
  resolveOfficialPluginFileDigests,
  type OfficialPluginDigestContract,
} from "../../src/app/official-plugin-digest/index.js";

describe("cli-official-plugin-digest contract", () => {
  it("declares its module manifest", () => {
    expect(cliOfficialPluginDigestModule.id).toBe("cli-official-plugin-digest");
    expect(cliOfficialPluginDigestModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("returns digests in listFiles order and reuses them within a process", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "zcode-digest-contract-"));
    try {
      const contract: OfficialPluginDigestContract = { resolveOfficialPluginFileDigests };
      const input = {
        appVersion: "contract-test",
        definition: { name: "contract-plugin", version: "1.0.0" },
        hashFile: (file: { path: string }) => file.path.padEnd(64, "0").slice(0, 64),
        listFiles: () => [
          { mode: 0o644, mtimeMs: 1, path: "a", size: 1, sourcePath: join(storageRoot, "a") },
          { mode: 0o644, mtimeMs: 2, path: "b", size: 2, sourcePath: join(storageRoot, "b") },
        ],
        rootPath: join(storageRoot, "source"),
        storageRoot,
      };
      const first = contract.resolveOfficialPluginFileDigests(input);
      const second = contract.resolveOfficialPluginFileDigests(input);
      expect(first.files.map((file) => file.path)).toEqual(["a", "b"]);
      expect(second.source).toBe("memory");
      expect(second.files).toEqual(first.files);
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
    }
  });
});
