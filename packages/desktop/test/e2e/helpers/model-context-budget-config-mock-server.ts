import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export interface ModelContextBudgetConfigMockServer {
  baseUrl: string;
  scenario: "config-pending";
  stop(): Promise<void>;
}

export function resolveModelContextBudgetConfigMockScenario(
  specs: readonly string[],
): "config-pending" | null {
  return specs.some((spec) => spec.includes("conversation-session-config-independent-startup"))
    ? "config-pending"
    : null;
}

/** 本地陷阱：官方配置入口应完全无请求；误接回旧服务时挂起，不能靠快速 mock 掩盖依赖。 */
export async function startModelContextBudgetConfigMockServer(
  scenario: "config-pending",
): Promise<ModelContextBudgetConfigMockServer> {
  let configRequests = 0;
  const heldResponses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__scb/status") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ blocked: true, configRequests, configResponses: 0 }));
      return;
    }
    configRequests += 1;
    heldResponses.add(response);
    response.on("close", () => heldResponses.delete(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Config tripwire did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    scenario,
    stop: async () => {
      for (const response of heldResponses) response.destroy();
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}
