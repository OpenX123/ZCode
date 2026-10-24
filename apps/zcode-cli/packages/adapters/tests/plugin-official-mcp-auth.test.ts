/* OMCP-001/002/007/018/020 —— Plugin loader 对 zcode_official 的严格解析（spec §4.2 / §5.2）。
   这里只验证"配置进入 runtime 的形状"，信任判定与身份头注入分别在 bootstrap 与 mcp adapter 测试。 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "official-mcp-plugin";
const MCP_KEY = "fake-official-search";
const RUNTIME_NAME = `plugin:${PLUGIN_NAME}:${MCP_KEY}`;

interface DiscoverOutcome {
  diagnostics: Array<{ code: string; message: string }>;
  mcpServers: Record<string, Record<string, unknown>>;
}

async function discoverWithMcpServer(server: Record<string, unknown>): Promise<{
  cleanup: () => Promise<void>;
  outcome: DiscoverOutcome;
}> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-official-mcp-plugin-"));
  const pluginRoot = join(dir, PLUGIN_NAME);
  await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN_NAME }),
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({ mcpServers: { [MCP_KEY]: server } }),
  );

  const outcome = (await createNodePluginAdapter({
    storageRoot: join(dir, "plugins"),
  }).discoverPlugins({
    config: { dirs: [pluginRoot], enabled: true, enabledPlugins: {}, options: {} },
    env: {},
    storageRoot: join(dir, "plugins"),
    workingDirectory: dir,
  })) as unknown as DiscoverOutcome;

  return { cleanup: () => rm(dir, { force: true, recursive: true }), outcome };
}

function expectDisabled(outcome: DiscoverOutcome): void {
  expect(outcome.mcpServers[RUNTIME_NAME]).toBeUndefined();
  expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "plugin_mcp_server_disabled",
  );
}

describe("独立 MCP 配置", () => {
  it.each([
    { type: "http", url: "https://mcp.example.test/mcp" },
    { type: "sse", url: "https://mcp.example.test/sse" },
    { type: "stdio", command: "node" },
  ])("旧官方 auth 声明阻止连接，不匿名降级：$type", async (transport) => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      ...transport,
      auth: { type: "zcode_official", provider: "jwt_token" },
    });
    try {
      expectDisabled(outcome);
    } finally {
      await cleanup();
    }
  });
  it("普通 HTTP MCP 保留用户 Header 与 OAuth，不生成官方来源", async () => {
    const { cleanup, outcome } = await discoverWithMcpServer({
      type: "http",
      url: "https://third-party.example/mcp",
      headers: { authorization: "Bearer user-owned" },
      oauth: { type: "authorization_code", clientId: "user-client" },
      official: { pluginId: "forged", mcpKey: "forged", source: "plugin" },
    });
    try {
      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.mcpServers[RUNTIME_NAME]).toMatchObject({
        type: "http",
        headers: { authorization: "Bearer user-owned" },
        oauth: { type: "authorization_code", clientId: "user-client" },
      });
      expect(outcome.mcpServers[RUNTIME_NAME]).not.toHaveProperty("auth");
      expect(outcome.mcpServers[RUNTIME_NAME]).not.toHaveProperty("official");
    } finally {
      await cleanup();
    }
  });
});
