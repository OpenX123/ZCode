import { describe, expect, it } from "vitest";
import { ENGINE_LABELS, isEngineNotReadyError } from "./contract.js";

describe("引擎名", () => {
  it("原生引擎统一显示 YCode（与 TaskClientLogo、输入框占位文案一致）", () => {
    expect(ENGINE_LABELS).toEqual({ zcode: "YCode", "claude-code": "Claude Code", codex: "Codex" });
  });
});

describe("外部引擎未就绪门禁", () => {
  it("识别 Host 与协议拒绝，不混同模型错误", () => {
    expect(isEngineNotReadyError({ code: "ZCODE_AGENT_ENGINE_NOT_READY" })).toBe(true);
    expect(isEngineNotReadyError({ reasonCode: "engine_not_ready" })).toBe(true);
    expect(isEngineNotReadyError(new Error("engine_not_ready: adapter missing"))).toBe(true);
    expect(isEngineNotReadyError(new Error("provider_not_ready"))).toBe(false);
  });
});
