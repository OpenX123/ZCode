import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeProviderRuntimePathEnv } from "@zcode/provider-node";

const telemetryMocks = vi.hoisted(() => ({
  closeMcp: vi.fn(async () => {}),
  emitMcpOnStart: false,
  emitToolOnAppCreate: false,
  disposeProcessProviderRegistryRuntime: vi.fn(),
  disposeProviderRegistryRuntime: vi.fn(),
  prepareModelTelemetryEnv: vi.fn(async (env: Record<string, string | undefined>) => env),
  shutdownPreparedModelTelemetry: vi.fn(async () => {}),
}));

vi.mock("../src/app/process-provider-registry-runtime.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/app/process-provider-registry-runtime.js")>();
  return {
    ...original,
    async startProcessProviderRegistryRuntime(
      ...args: Parameters<typeof original.startProcessProviderRegistryRuntime>
    ) {
      const started = await original.startProcessProviderRegistryRuntime(...args);
      return {
        ...started,
        dispose() {
          telemetryMocks.disposeProcessProviderRegistryRuntime();
          started.dispose();
        },
        runtime: new Proxy(started.runtime, {
          get(target, property, receiver) {
            if (property !== "dispose") return Reflect.get(target, property, receiver);
            return () => {
              telemetryMocks.disposeProviderRegistryRuntime();
              target.dispose();
            };
          },
        }),
      };
    },
  };
});

vi.mock("@zcode/adapters/mcp", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/adapters/mcp")>();
  return {
    ...original,
    createMcpAdapter: () => ({ close: telemetryMocks.closeMcp }),
    createMcpAdapterConnectionPool: () => ({
      acquireLease: () => ({ close: async () => {} }),
      close: telemetryMocks.closeMcp,
    }),
    createMcpTelemetryTracker(options: Parameters<typeof original.createMcpTelemetryTracker>[0]) {
      const tracker = original.createMcpTelemetryTracker(options);
      return {
        ...tracker,
        start() {
          tracker.start();
          if (!telemetryMocks.emitMcpOnStart) return;
          options.onResourceSamples?.([
            {
              mcpId: "builtin:node_repl",
              instanceToken: "cli-instance-01",
              sampledAt: 300000,
              intervalMs: 300000,
              processCount: 2,
              rssKbTotal: 120000,
              rssKbMaxProcess: 80000,
              cpuTimeMsDelta: 30000,
              uptimeMinutes: 5,
              platform: "linux",
              arch: "x64",
              logicalCpuCount: 8,
              totalMemoryGb: 32,
            },
          ]);
          options.onEvent({
            kind: "memory",
            mcpId: "builtin:node_repl",
            mcpInstanceId: "instance-1",
            mcpIsolation: "session",
            mcpSource: "builtin",
            memoryKb: 120000,
            memoryScope: "process_tree",
            orphanSuspected: false,
            ownerSessionCount: 1,
            unownedSeconds: 0,
            platform: "linux",
            arch: "x64",
            occurredAt: 300000,
          });
        },
      };
    },
  };
});

// 在 App 装配边界模拟已结束的 Bash，验证入口不会把回调丢在配置透传途中。
vi.mock("../src/app/create-app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/app/create-app.js")>();
  return {
    ...original,
    async createZCodeApp(options: Parameters<typeof original.createZCodeApp>[0]) {
      if (telemetryMocks.emitToolOnAppCreate)
        options.onToolExecResource?.({
          platform: "linux",
          toolName: "bash",
          durationMs: 40000,
          exitKind: "completed",
          sampleCount: 2,
          treeRssKbPeak: 300,
          treeCpuTimeMs: 6000,
          cliRssKb: 1024,
          systemFreeMemoryKb: 2048,
        });
      if (telemetryMocks.emitToolOnAppCreate)
        throw new Error("test app completed telemetry handoff");
      return original.createZCodeApp(options);
    },
  };
});

import { runZCodeProtocolAgent } from "../src/zcode-protocol-entrypoint.js";

describe("ZCode Protocol telemetry lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    telemetryMocks.emitMcpOnStart = false;
    telemetryMocks.emitToolOnAppCreate = false;
  });

  it("启动和退出不创建原厂遥测 owner", async () => {
    await runProtocolAgent(undefined);
    expect(telemetryMocks.prepareModelTelemetryEnv).not.toHaveBeenCalled();
    expect(telemetryMocks.shutdownPreparedModelTelemetry).not.toHaveBeenCalled();
  });

  it("MCP 资源数组从入口发到新通知，旧 memory 内部事实不再发上协议", async () => {
    telemetryMocks.emitMcpOnStart = true;
    const chunks: string[] = [];
    await runProtocolAgent(undefined, chunks);
    const messages = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messages.filter((message) => message.method === "process/mcpResourceSamples")).toEqual([
      {
        method: "process/mcpResourceSamples",
        params: [expect.objectContaining({ mcpId: "builtin:node_repl", rssKbTotal: 120000 })],
      },
    ]);
    expect(
      messages.some(
        (message) => message.method === "process/mcpTelemetry" && message.params?.kind === "memory",
      ),
    ).toBe(false);
  });

  it("App 的 Bash 完成回调经入口进入独立协议通知", async () => {
    telemetryMocks.emitToolOnAppCreate = true;
    const chunks: string[] = [];
    await runProtocolAgent(undefined, chunks, true);
    const messages = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messages.find((message) => message.id === "test-create")?.error?.message).toBe(
      "test app completed telemetry handoff",
    );
    expect(messages.filter((message) => message.method === "process/toolExecResource")).toEqual([
      {
        method: "process/toolExecResource",
        params: expect.objectContaining({ toolName: "bash", durationMs: 40000 }),
      },
    ]);
  });

  it("Protocol 关闭时释放完整 Process Provider Registry Runtime owner", async () => {
    await runProtocolAgent(undefined);

    expect(telemetryMocks.disposeProcessProviderRegistryRuntime).toHaveBeenCalledOnce();
    expect(telemetryMocks.disposeProviderRegistryRuntime).not.toHaveBeenCalled();
  });
});

async function runProtocolAgent(
  runtimeSurface: "remote_workspace_host" | undefined,
  outputChunks?: string[],
  createSession = false,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-protocol-telemetry-lifecycle-"));
  try {
    const providerEnv = await createProtocolProviderEnv(root);
    const input = new PassThrough();
    if (createSession)
      input.write(
        JSON.stringify({
          id: "test-create",
          method: "session/create",
          params: { workspace: { workspacePath: root, workspaceKey: root } },
        }) + "\n",
      );
    else input.end();
    await runZCodeProtocolAgent({
      env: {
        ZCODE_LOG_DIR: join(root, "log"),
        ZCODE_SESSION_DB_PATH: join(root, "session.sqlite"),
        ZCODE_STORAGE_DIR: root,
        ...providerEnv,
        ...(runtimeSurface ? { ZCODE_TELEMETRY_RUNTIME_SURFACE: runtimeSurface } : {}),
      },
      input,
      output: new Writable({
        write(chunk, _encoding, callback) {
          outputChunks?.push(chunk.toString());
          if (createSession)
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
              const message = JSON.parse(line);
              if (message.method === "session/requestRuntimePreferences")
                input.write(
                  JSON.stringify({
                    id: message.id,
                    result: { nativeSearchEnhancementsEnabled: false },
                  }) + "\n",
                );
            }
          if (
            createSession &&
            chunk
              .toString()
              .split("\n")
              .filter(Boolean)
              .some((line: string) => JSON.parse(line).id === "test-create")
          )
            input.end();
          callback();
        },
      }),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function createProtocolProviderEnv(root: string): Promise<Record<string, string>> {
  const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
  const personalFilePath = join(root, "provider-personal.json");
  const emptyBuiltinRelease = JSON.stringify({
    // 旧 fixture 使用已退出的 v2 展开结构，导致生命周期尚未启动就被 schema 拒绝。
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
  const emptyPersonalConfig = JSON.stringify({
    schemaVersion: 1,
    providers: {},
    modelConfigRules: [],
  });
  await Promise.all([
    writeFile(zcodeBuiltinFilePath, emptyBuiltinRelease),
    writeFile(personalFilePath, emptyPersonalConfig),
  ]);
  return createNodeProviderRuntimePathEnv({ zcodeBuiltinFilePath, personalFilePath });
}
