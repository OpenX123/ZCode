import { expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

function configEvent(payload: Record<string, unknown>, sequenceNumber: number): SessionEvent {
  return {
    id: `e-${sequenceNumber}`,
    sessionId: "s1",
    traceId: "trace-1",
    timestamp: new Date(sequenceNumber * 1000),
    type: SessionEventType.ExternalEngineConfigUpdated,
    payload: { engine: "codex", engineConfigOptions: [], ...payload },
    sequenceNumber,
  } as SessionEvent;
}

it("连接配置绑定只读投影到 snapshot，尚未解析的 connecting 事件保留已投影值", () => {
  const projection = new ProductProjection("s1", "epoch");
  projection.applyEvent(configEvent({ engineConfigState: "connecting" }, 1));
  expect(projection.getSnapshot().config.engineConnectionProfileId).toBeUndefined();
  projection.applyEvent(
    configEvent({ engineConfigState: "ready", engineConnectionProfileId: "gateway-a" }, 2),
  );
  expect(projection.getSnapshot().config.engineConnectionProfileId).toBe("gateway-a");
  projection.applyEvent(configEvent({ engineConfigState: "connecting" }, 3));
  expect(projection.getSnapshot().config).toMatchObject({
    engineConfigState: "connecting",
    engineConnectionProfileId: "gateway-a",
  });
});
