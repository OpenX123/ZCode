import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SubagentRuntimeState } from "@zcode/shared";
import {
  createSubagentRuntimeConfigCache,
  type ConfigReader,
  type SubagentRuntimeConfigCache,
  type Workspace,
} from "./index.js";

describe("subagent-runtime-config contract", () => {
  it("prepares file-backed snapshots, isolates readers and rejects reads after disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-config-contract-"));
    const userRoot = join(root, "user");
    const statePath = join(root, "state", "agents-state.json");
    const workspace: Workspace = { workspacePath: join(root, "workspace") };
    const reader: ConfigReader = {
      readUserRoot: async () => userRoot,
      readStatePath: async () => statePath,
      readState: async (path) => JSON.parse(await readFile(path, "utf8")) as SubagentRuntimeState,
    };
    const cache: SubagentRuntimeConfigCache = createSubagentRuntimeConfigCache(reader);
    try {
      await Promise.all([
        mkdir(userRoot),
        mkdir(dirname(statePath)),
        mkdir(join(workspace.workspacePath, ".zcode", "agents"), { recursive: true }),
      ]);
      await writeFile(
        statePath,
        JSON.stringify({
          disabledAgentIds: [],
          builtInModelSelectionOverrides: {},
          pluginAgentModelSelectionOverrides: {},
        }),
      );
      await writeFile(
        join(userRoot, "researcher.md"),
        "---\nname: researcher\ndescription: Research\n---\nOriginal prompt",
      );
      await expect(cache.read(workspace)).rejects.toThrow("not prepared");
      await cache.prepare(workspace);
      const snapshot = await cache.read(workspace);
      expect(snapshot).toMatchObject({
        kind: "ready",
        profiles: [{ name: "researcher", systemPrompt: "Original prompt" }],
      });
      if (snapshot.kind !== "ready") throw new Error("Expected a prepared snapshot");
      snapshot.profiles[0]!.systemPrompt = "Caller mutation";
      expect(await cache.read(workspace)).toMatchObject({
        kind: "ready",
        profiles: [{ name: "researcher", systemPrompt: "Original prompt" }],
      });
      cache.dispose();
      cache.dispose();
      await expect(cache.read(workspace)).rejects.toThrow("disposed");
      await expect(cache.prepare(workspace)).rejects.toThrow("disposed");
    } finally {
      cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
