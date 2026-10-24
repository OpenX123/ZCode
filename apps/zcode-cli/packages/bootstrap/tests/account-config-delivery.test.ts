import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "account-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const started = await startProcessProviderRegistryRuntime({
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(directory, "personal.json"),
  });
  cleanups.unshift(async () => started.dispose());
  return started;
}

describe("独立 harness 账号交付边界", () => {
  it("拒绝旧官方账号交付，不创建会话且不修改本地 Registry", async () => {
    const started = await startRuntime();
    const previous = started.runtime.registryService.getSnapshot();
    const createZCodeApp = vi.fn(() => {
      throw new Error("不应创建会话");
    });
    const server = new ZCodeProtocolAgentServer({ createZCodeApp });
    expect(
      await server.handleMessage({
        id: 1,
        method: "provider/updateAccountConfig",
        params: {
          revision: "legacy-account",
          basedOnZCodeBuiltinRevision: "legacy-builtin",
          providers: {},
          states: {},
        },
      }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(createZCodeApp).not.toHaveBeenCalled();
    expect(started.runtime.registryService.getSnapshot()).toBe(previous);
  });
});
