import type { ExternalEnginePort } from "./contract.js";
export async function closeExternalEngineExample(port: ExternalEnginePort): Promise<void> {
  await port.closeSession("example");
}
