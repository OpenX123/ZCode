import type { MermaidRenderingContract } from "./contract.js";

/** 先同步读取成功缓存，未命中再共享异步请求；渲染后的 SVG 仍需按挂载实例隔离 ID。 */
export async function exampleMermaidRendering(contract: MermaidRenderingContract): Promise<string> {
  const request = { source: "flowchart TD\nA-->B", config: { theme: "base" as const } };
  return contract.coordinator.peek(request) ?? contract.coordinator.render(request);
}
