import type { McpServerConfig, McpToolDescriptor } from "@zcode/contracts";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeMcpServerFingerprint,
  createFileMcpToolManifestCache,
} from "../src/mcp/tool-manifest-cache.js";

const SECRET = "sk-live-should-never-be-written";
const STDIO: McpServerConfig = {
  args: ["C:/plugins/cache/zcode-plugins-official/documents/0.2.0/dist/server.mjs"],
  command: "C:/Program Files/YCode/YCode.exe",
  env: {
    API_TOKEN: SECRET,
    ZCODE_PLUGIN_ID: "documents@zcode-plugins-official",
    ZCODE_PLUGIN_ROOT: "C:/plugins/cache/zcode-plugins-official/documents/0.2.0",
  },
  type: "stdio",
};
const TOOLS: McpToolDescriptor[] = [
  {
    description: "Create a document",
    inputSchema: { properties: { title: { type: "string" } }, type: "object" },
    serverName: "docs",
    toolName: "create",
  },
];

describe("MCP 工具清单缓存", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-manifest-"));
    roots.push(root);
    return root;
  }

  it("写入后在新进程（新实例）中按同一配置读回", async () => {
    const rootDir = await createRoot();
    await createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir }).write(
      "docs",
      STDIO,
      TOOLS,
    );

    const reader = createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir });
    expect(await reader.read("docs", STDIO)).toEqual(TOOLS);
    // 应用版本变化即视为不同的 server 构建。
    const upgraded = createFileMcpToolManifestCache({ appVersion: "1.1.1", rootDir });
    expect(await upgraded.read("docs", STDIO)).toBeUndefined();
  });

  it("指纹只取 env 与 header 的键名，密钥值不参与也不落盘", async () => {
    const rotated: McpServerConfig = { ...STDIO, env: { ...STDIO.env, API_TOKEN: "rotated" } };
    expect(computeMcpServerFingerprint("docs", rotated, "1.1.0")).toBe(
      computeMcpServerFingerprint("docs", STDIO, "1.1.0"),
    );
    const extraKey: McpServerConfig = { ...STDIO, env: { ...STDIO.env, EXTRA: "1" } };
    expect(computeMcpServerFingerprint("docs", extraKey, "1.1.0")).not.toBe(
      computeMcpServerFingerprint("docs", STDIO, "1.1.0"),
    );
    const newerPlugin: McpServerConfig = {
      ...STDIO,
      env: { ...STDIO.env, ZCODE_PLUGIN_ROOT: "C:/plugins/cache/documents/0.2.1" },
    };
    expect(computeMcpServerFingerprint("docs", newerPlugin, "1.1.0")).not.toBe(
      computeMcpServerFingerprint("docs", STDIO, "1.1.0"),
    );
    const http: McpServerConfig = {
      headers: { Authorization: `Bearer ${SECRET}` },
      type: "http",
      url: `https://mcp.example.test/v1?token=${SECRET}`,
    };
    const httpRotated: McpServerConfig = {
      headers: { authorization: "Bearer other" },
      type: "http",
      url: "https://mcp.example.test/v1?token=other",
    };
    expect(computeMcpServerFingerprint("remote", httpRotated, "1.1.0")).toBe(
      computeMcpServerFingerprint("remote", http, "1.1.0"),
    );

    const rootDir = await createRoot();
    const cache = createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir });
    await cache.write("docs", STDIO, TOOLS);
    await cache.write("remote", http, [{ ...TOOLS[0]!, serverName: "remote" }]);
    for (const name of await readdir(rootDir)) {
      expect(await readFile(join(rootDir, name), "utf8")).not.toContain(SECRET);
    }
  });

  it("损坏或指纹不符的文件按未命中处理，失效后不再命中", async () => {
    const rootDir = await createRoot();
    const cache = createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir });
    await cache.write("docs", STDIO, TOOLS);
    const [fileName] = await readdir(rootDir);
    const filePath = join(rootDir, fileName!);

    await writeFile(filePath, "{broken");
    expect(await createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir }).read("docs", STDIO))
      .toBeUndefined();

    await writeFile(
      filePath,
      JSON.stringify({ fingerprint: "other", savedAt: "x", serverName: "docs", tools: TOOLS, version: 1 }),
    );
    expect(await createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir }).read("docs", STDIO))
      .toBeUndefined();

    const fresh = createFileMcpToolManifestCache({ appVersion: "1.1.0", rootDir });
    await fresh.write("docs", STDIO, TOOLS);
    expect(await fresh.read("docs", STDIO)).toEqual(TOOLS);
    await fresh.invalidate("docs", STDIO);
    expect(await fresh.read("docs", STDIO)).toBeUndefined();
  });

  it("同内容不重复写盘，目录条目超过上限时淘汰最旧文件", async () => {
    const rootDir = await createRoot();
    const cache = createFileMcpToolManifestCache({ appVersion: "1.1.0", maxEntries: 2, rootDir });
    await cache.write("docs", STDIO, TOOLS);
    const [fileName] = await readdir(rootDir);
    const filePath = join(rootDir, fileName!);
    const old = new Date(Date.now() - 60_000);
    await utimes(filePath, old, old);
    await cache.write("docs", STDIO, TOOLS);
    expect((await stat(filePath)).mtimeMs).toBe(old.getTime());

    for (const serverName of ["a", "b"]) {
      await cache.write(serverName, STDIO, [{ ...TOOLS[0]!, serverName }]);
    }
    const remaining = await readdir(rootDir);
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(fileName);
  });
});
