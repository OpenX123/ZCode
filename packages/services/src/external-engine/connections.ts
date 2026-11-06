import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  EXTERNAL_ENGINE_CONNECTIONS_FILE,
  INHERITED_ENGINE_CONNECTION,
  externalEngineConnectionsSchema,
  externalEngineConnectionProfileSchema,
  type ExternalEngineConnections,
  type SaveExternalEngineConnection,
} from "@zcode/shared/external-engine";
import type { ICredentialService } from "../credential/credential.js";

export function createEngineConnections(enginesDir: string, credentials?: ICredentialService) {
  const file = join(enginesDir, EXTERNAL_ENGINE_CONNECTIONS_FILE);
  const read = async (): Promise<ExternalEngineConnections> => {
    try {
      return externalEngineConnectionsSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { activeProfileId: "inherit", profiles: [INHERITED_ENGINE_CONNECTION] };
      throw new Error("external_engine_connections_unreadable");
    }
  };
  return {
    read,
    async save(input: SaveExternalEngineConnection) {
      if (!["inherit", "official", "apiKey"].includes(input.mode))
        throw new Error("external_engine_connection_invalid");
      const id = input.mode === "inherit" ? "inherit" : randomUUID();
      const credentialKey = input.mode === "apiKey" ? `external-engine:codex:${id}` : undefined;
      let baseUrl = input.baseUrl?.trim() || "https://api.openai.com/v1";
      let apiKey = input.apiKey?.trim();
      if (input.mode === "apiKey") {
        let url: URL;
        try {
          url = new URL(baseUrl);
        } catch {
          throw new Error("external_engine_connection_url_invalid");
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("external_engine_connection_url_invalid");
        baseUrl = url.toString().replace(/\/$/, "");
        if (!apiKey && credentials) {
          const current = await read();
          const previous = current.profiles.find((item) => item.id === current.activeProfileId);
          if (previous?.mode === "apiKey" && previous.credentialKey)
            apiKey = (await credentials.load(previous.credentialKey)) ?? undefined;
        }
        if (!apiKey || !credentials) throw new Error("external_engine_api_key_missing");
      }
      const profile = externalEngineConnectionProfileSchema.parse({
        id,
        mode: input.mode,
        ...(input.mode === "apiKey" ? { baseUrl, credentialKey, hasApiKey: true } : {}),
        ...(input.mode !== "inherit" && input.model?.trim() ? { model: input.model.trim() } : {}),
      });
      await mkdir(enginesDir, { recursive: true });
      if (credentialKey) await credentials!.save(credentialKey, apiKey!);
      try {
        await withFileLock(file, async () => {
          const current = await read();
          const profiles =
            profile.id === "inherit" ? current.profiles : [...current.profiles, profile];
          await atomicWritePrivateTextFile(
            file,
            JSON.stringify({ activeProfileId: profile.id, profiles }),
          );
        });
      } catch (error) {
        if (credentialKey) await credentials!.delete(credentialKey);
        throw error;
      }
      return profile;
    },
    home: (id: string) => join(enginesDir, "connections", id, "codex-home"),
  };
}
