import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  type Logger,
  type McpConnectionSnapshot,
  type McpPort,
  type McpServerStatus,
  type McpToolDescriptor,
} from "@zcode/contracts";
import { createBorrowedSubagentMcpAccess } from "../src/subagent/borrowed-mcp-port.js";
import { matchesRequiredMcpServer } from "../src/subagent/mcp-config.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const SERVERS = {
  docs: { type: "stdio" as const, command: "node", args: ["docs.js"] },
  sheets: { type: "stdio" as const, command: "node", args: ["sheets.js"] },
};

function tool(serverName: string, toolName: string, inputSchema = { type: "object" }) {
  return { inputSchema, serverName, toolName } as McpToolDescriptor;
}

const DEFERRED_STATUS: McpServerStatus = {
  deferredStart: true,
  status: "disconnected",
  toolCount: 1,
  transport: "stdio",
  updatedAt: "now",
};

/** 模拟会话 lease：startConfiguredServers 立即返回缓存工具，revision 由测试推进。 */
function createLazyPort(initial: McpConnectionSnapshot) {
  let revision = initial.toolListRevision ?? 0;
  let tools = initial.tools;
  let statuses = initial.statuses;
  const port: McpPort & {
    advance(next: Partial<McpConnectionSnapshot>): void;
  } = {
    advance(next) {
      revision += 1;
      if (next.tools) tools = next.tools;
      if (next.statuses) statuses = next.statuses;
    },
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: async () => undefined,
    // 非阻塞端口不应退回阻塞连接；永不 resolve 用来证明首个请求没有等它。
    connectConfiguredServers: vi.fn(() => new Promise<McpConnectionSnapshot>(() => undefined)),
    connectServer: vi.fn(),
    disconnectServer: async () => undefined,
    listTools: async () => [...tools],
    startConfiguredServers: vi.fn(async () => ({ ...initial, toolListRevision: revision })),
    status: async () => ({ ...statuses }),
    toolListRevision: () => revision,
  } as never;
  return port;
}

function modelFactoryRecordingTools(seen: string[][]) {
  return createTestModelFactory({
    async generateText(request: any) {
      seen.push(request.tools.map((entry: { name: string }) => entry.name));
      return {
        finishReason: "stop",
        providerMetadata: undefined,
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as never);
}

describe("会话 MCP 非阻塞启动（runtime）", () => {
  it("首个模型请求不等待 MCP 连接，按缓存注册的工具已可见", async () => {
    const sessionId = createSessionId("runtime-lazy-mcp-first-request");
    const port = createLazyPort({
      statuses: { docs: DEFERRED_STATUS },
      tools: [tool("docs", "create")],
    });
    const seen: string[][] = [];
    const info = vi.fn();
    const logger: Logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info,
      warn: () => undefined,
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: { docs: SERVERS.docs } } },
      {
        eventStore: createTestSessionEventStore(),
        logger,
        mcpPort: port,
        modelFactory: modelFactoryRecordingTools(seen),
      },
    );

    await runtime.executeTurn("create a document");

    expect(port.startConfiguredServers).toHaveBeenCalledOnce();
    expect(port.connectConfiguredServers).not.toHaveBeenCalled();
    expect(seen[0]).toContain("mcp__docs__create");
    expect(info).toHaveBeenCalledWith(
      "MCP startup completed",
      expect.objectContaining({ deferredCount: 1, event: "mcp.startup.completed", mode: "lazy" }),
    );
    expect(info).toHaveBeenCalledWith(
      "Turn first model request started",
      expect.objectContaining({
        durationMs: expect.any(Number),
        event: "turn.first_model_request.started",
      }),
    );
    expect(
      info.mock.calls.filter(([message]) => message === "Turn first model request started"),
    ).toHaveLength(1);
  });

  it("后台连上的 server 与清单漂移都在下一次刷新时以真实清单重注册", async () => {
    const sessionId = createSessionId("runtime-lazy-mcp-refresh");
    const traceContext = createRootTraceContext({ sessionId });
    const port = createLazyPort({
      statuses: { docs: DEFERRED_STATUS },
      tools: [tool("docs", "create")],
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: SERVERS } },
      { eventStore: createTestSessionEventStore(), mcpPort: port, traceContext },
    );
    const internals = runtime as unknown as {
      initializeMcp(trace: typeof traceContext): Promise<void>;
      refreshMcpToolsIfChanged(trace: typeof traceContext): Promise<void>;
    };
    await internals.initializeMcp(traceContext);
    expect(runtime.getToolRegistry().get("mcp__docs__create")).toBeDefined();
    expect(runtime.getToolRegistry().get("mcp__sheets__read")).toBeUndefined();

    // 后台连接完成：sheets 的工具从下一次刷新起加入。
    port.advance({ tools: [tool("docs", "create"), tool("sheets", "read")] });
    await internals.refreshMcpToolsIfChanged(traceContext);
    expect(runtime.getToolRegistry().get("mcp__sheets__read")).toBeDefined();

    // 首次调用连上后真实 schema 与缓存不同：名称、描述相同也必须重注册。
    const driftedSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    port.advance({ tools: [tool("docs", "create", driftedSchema), tool("sheets", "read")] });
    await internals.refreshMcpToolsIfChanged(traceContext);
    expect(runtime.getToolRegistry().get("mcp__docs__create")?.inputSchema).toMatchObject({
      required: ["title"],
    });
  });

  it("以快照前的 revision 为基线，快照之后完成的后台连接不会被漏掉", async () => {
    const sessionId = createSessionId("runtime-lazy-mcp-baseline");
    const traceContext = createRootTraceContext({ sessionId });
    const port = createLazyPort({ statuses: {}, tools: [], toolListRevision: 0 });
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: { sheets: SERVERS.sheets } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port, traceContext },
    );
    // 后台连接在快照返回后、注册前完成：端口 revision 已前进，快照仍是旧的。
    port.advance({ tools: [tool("sheets", "read")] });
    const internals = runtime as unknown as {
      initializeMcp(trace: typeof traceContext): Promise<void>;
      refreshMcpToolsIfChanged(trace: typeof traceContext): Promise<void>;
    };
    await internals.initializeMcp(traceContext);
    await internals.refreshMcpToolsIfChanged(traceContext);
    expect(runtime.getToolRegistry().get("mcp__sheets__read")).toBeDefined();
  });
});

// P10（docs/desktop/engine-performance-1.1-spec.md §1「草稿不触发 MCP」）：升级后首启 manifest 缓存
// 未命中时，7 个从未发送的草稿拉起了 28 个 MCP 进程。草稿推迟到首次需要工具时才登记与启动。
describe("草稿推迟 MCP 启动", () => {
  function createRuntime(deferMcpStartupUntilFirstUse: boolean | undefined) {
    const port = createLazyPort({
      statuses: { docs: DEFERRED_STATUS },
      tools: [tool("docs", "create")],
    });
    const seen: string[][] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(`runtime-draft-mcp-${String(deferMcpStartupUntilFirstUse)}`),
      {
        mode: "build",
        mcp: { enabled: true, servers: { docs: SERVERS.docs } },
        ...(deferMcpStartupUntilFirstUse === undefined ? {} : { deferMcpStartupUntilFirstUse }),
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: port,
        modelFactory: modelFactoryRecordingTools(seen),
      },
    );
    return { port, runtime, seen };
  }

  it("草稿构造与 context 初始化（如 / 技能目录）都不启动 MCP；首次发送时启动且首个请求已带缓存工具", async () => {
    const { port, runtime, seen } = createRuntime(true);
    expect(port.startConfiguredServers).not.toHaveBeenCalled();

    await runtime.getSkillCatalog(createRootTraceContext());
    expect(port.startConfiguredServers).not.toHaveBeenCalled();

    await runtime.executeTurn("create a document");
    expect(port.startConfiguredServers).toHaveBeenCalledOnce();
    expect(seen[0]).toContain("mcp__docs__create");
  });

  it("非草稿（缺省）保持构造即登记 MCP", () => {
    const { port } = createRuntime(undefined);
    expect(port.startConfiguredServers).toHaveBeenCalledOnce();
  });
});

describe("子智能体借用待首次使用的 server", () => {
  it("待首次使用的 server 满足必需 server 并可借用其工具", async () => {
    const parent = createLazyPort({
      statuses: { docs: DEFERRED_STATUS },
      tools: [tool("docs", "create")],
    });
    expect(matchesRequiredMcpServer("docs", { docs: DEFERRED_STATUS })).toBe(true);
    expect(matchesRequiredMcpServer("*", { docs: DEFERRED_STATUS })).toBe(true);
    expect(
      matchesRequiredMcpServer("docs", { docs: { ...DEFERRED_STATUS, deferredStart: undefined } }),
    ).toBe(false);

    const borrowed = createBorrowedSubagentMcpAccess(parent, {
      statuses: { docs: DEFERRED_STATUS },
      tools: [tool("docs", "create")],
    });
    expect(borrowed.snapshot.tools).toEqual([tool("docs", "create")]);
    await borrowed.port.callTool({ serverName: "docs", toolName: "create" });
    // 调用交给 parent 端口，由 parent lease 按首次使用规则启动 server。
    expect(parent.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "docs", toolName: "create" }),
      undefined,
    );
  });
});
