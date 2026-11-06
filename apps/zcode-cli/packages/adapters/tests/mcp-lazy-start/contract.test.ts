import type { McpToolDescriptor } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { cliMcpLazyStartModule } from "../../src/mcp/lazy-start/module.js";
import {
  createMcpLeaseServerLifecycle,
  type McpToolManifestCache,
} from "../../src/mcp/lazy-start/index.js";

const TOOLS: McpToolDescriptor[] = [
  { inputSchema: { type: "object" }, serverName: "docs", toolName: "create" },
];
const CONFIG = { command: "node", type: "stdio" as const };

function memoryCache(tools?: McpToolDescriptor[]): McpToolManifestCache {
  return {
    invalidate: vi.fn(async () => undefined),
    read: vi.fn(async () => tools),
    write: vi.fn(async () => undefined),
  };
}

function connectedAcquire() {
  return vi.fn(async () => ({
    status: "connected" as const,
    toolCount: 1,
    transport: "stdio" as const,
    updatedAt: "now",
  }));
}

describe("cli-mcp-lazy-start contract", () => {
  it("declares its module manifest", () => {
    expect(cliMcpLazyStartModule.id).toBe("cli-mcp-lazy-start");
    expect(cliMcpLazyStartModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("registers cached servers as deferred and starts them only on first use", async () => {
    const acquire = connectedAcquire();
    const lifecycle = createMcpLeaseServerLifecycle({
      acquire,
      cache: memoryCache(TOOLS),
      readServerTools: async () => TOOLS,
    });

    const registered = await lifecycle.register([["docs", CONFIG]], {});

    expect(registered.deferredNames).toEqual(["docs"]);
    expect(lifecycle.deferredStatus("docs")).toMatchObject({ deferredStart: true });
    expect(lifecycle.cachedTools("docs")).toEqual(TOOLS);
    expect(acquire).not.toHaveBeenCalled();
    await expect(lifecycle.use("docs", "tool_call", async () => "done")).resolves.toBe("done");
    expect(acquire).toHaveBeenCalledOnce();
    expect(lifecycle.deferredStatus("docs")).toBeUndefined();
    lifecycle.close();
  });

  it("asks the lease to reclaim only after an idle window without in-flight use", async () => {
    vi.useFakeTimers();
    try {
      const onIdle = vi.fn();
      const lifecycle = createMcpLeaseServerLifecycle({
        acquire: connectedAcquire(),
        cache: memoryCache(),
        idleReclaimMs: 1_000,
        onIdle,
        readServerTools: async () => TOOLS,
      });
      lifecycle.connected("docs");
      const release = Promise.withResolvers<void>();
      const inFlight = lifecycle.use("docs", "tool_call", () => release.promise);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onIdle).not.toHaveBeenCalled();
      release.resolve();
      await inFlight;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onIdle).toHaveBeenCalledOnce();
      const [, isStillIdle] = onIdle.mock.calls[0] as [string, () => boolean];
      expect(isStillIdle()).toBe(true);
      lifecycle.connected("docs");
      expect(isStillIdle()).toBe(false);
      lifecycle.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
