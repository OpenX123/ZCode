import { access, mkdir, watch, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
const requireAdapter = createRequire(
  new URL("../../../../../../apps/zcode-cli/packages/adapters/package.json", import.meta.url),
);
const { McpServer } = requireAdapter("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = requireAdapter("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = requireAdapter("zod");
const server = new McpServer({ name: "conversation-groups-e2e", version: "1.0.0" });
server.registerTool(
  "call",
  {
    description: "Return a deterministic MCP conversation result after an explicit E2E gate.",
    inputSchema: { value: z.string(), gate: z.string().optional(), fail: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
    _meta: { "anthropic/alwaysLoad": true },
  },
  async ({ value, gate, fail }) => {
    if (gate) {
      const root = process.env.E2E_MCP_GROUP_GATE_ROOT;
      if (!root) throw new Error("Missing explicit MCP E2E gate root");
      await mkdir(root, { recursive: true });
      const watcher = watch(root);
      let next = watcher.next();
      await writeFile(join(root, `${gate}.started`), "started");
      try {
        while (!(await next).done) {
          if (
            await access(join(root, `${gate}.release`)).then(
              () => true,
              () => false,
            )
          )
            break;
          next = watcher.next();
        }
      } finally {
        await watcher.return();
      }
    }
    return {
      content: [{ type: "text", text: fail ? `UX06_ERROR:${value}` : `UX06_RESULT:${value}` }],
      ...(fail ? { isError: true } : {}),
    };
  },
);
await server.connect(new StdioServerTransport());
