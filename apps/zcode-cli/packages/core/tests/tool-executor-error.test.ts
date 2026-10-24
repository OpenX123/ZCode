import { describe, expect, it } from "vitest";
import {
  HookEventName,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  CoreErrorType,
  createCoreError,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { stringifyToolResultOutput } from "../src/runtime/helpers/tool-result.js";
import { createTurnFailureError } from "../src/runtime/helpers/turn-errors.js";
import { ErrorPayloadRole, withErrorPayloadRole } from "../src/errors/error-payload.js";
import { createErrorResult, createPermissionErrorResult } from "../src/tool/executor/errors.js";
import type { ExecutableToolCall } from "../src/tool/types.js";

const USER_DENIAL_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

describe("tool executor error projection", () => {
  it("keeps user-denial content provider-visible", () => {
    const result = createPermissionErrorResult(agentToolCall(), USER_DENIAL_CONTENT, {});

    expect(stringifyToolResultOutput(result)).toBe(USER_DENIAL_CONTENT);
  });

  it("keeps denial feedback in the same provider-visible tool_result", () => {
    const reason = `${USER_DENIAL_CONTENT} To tell you how to proceed, the user said:\nPlease use the existing file instead.`;
    const result = createPermissionErrorResult(
      agentToolCall(),
      reason,
      {},
      {
        preserveReasonFormatting: true,
      },
    );

    expect(stringifyToolResultOutput(result)).toBe(reason);
  });

  it("sanitizes denial feedback unless preservation is explicitly requested", () => {
    const reason = `${USER_DENIAL_CONTENT}\nTo tell you how to proceed, the user said:\n${"x".repeat(600)}`;
    const result = createPermissionErrorResult(agentToolCall(), reason, {});

    expect(result.error?.message).toHaveLength(500);
    expect(result.error?.message).not.toContain("\n");
    expect(result.error?.message).toMatch(/\.\.\.$/);
  });

  it("surfaces provider/model cause details for failed parent Agent tool calls", () => {
    const providerError = Object.assign(
      new Error("Model provider is not configured: old-provider"),
      {
        code: "provider_not_found",
        context: {
          providerId: "old-provider",
          modelId: "old-model",
        },
        name: "AiSdkModelAdapterError",
      },
    );
    const turnError = createTurnFailureError(providerError, undefined, "Turn execution failed");

    const result = createErrorResult(agentToolCall(), turnError);

    expect(result.error?.message).toBe("Model provider is not configured: old-provider");
    expect(result.error?.detail).toContain("Turn execution failed");
    expect(result.error?.detail).toContain("provider=old-provider");
    expect(result.error?.detail).toContain("model=old-model");
    expect(stringifyToolResultOutput(result)).toBe(
      "Model provider is not configured: old-provider",
    );
  });

  it("keeps provider cause identity when subagent wrappers add context", () => {
    const providerError = Object.assign(
      new Error("Model provider is not configured: old-provider"),
      {
        code: "provider_not_found",
        context: {
          providerId: "old-provider",
          modelId: "old-model",
        },
        name: "AiSdkModelAdapterError",
      },
    );
    const subagentError = createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Explore subagent failed",
      {
        cause: providerError,
        context: withErrorPayloadRole(
          {
            code: "agent_child_runtime_failed",
            agentId: "agent_e2e",
            agentType: "e2e-stale-error-reviewer",
          },
          ErrorPayloadRole.Wrapper,
        ),
        recoverable: true,
      },
    );

    const result = createErrorResult(agentToolCall(), subagentError);

    expect(result.error?.message).toBe("Model provider is not configured: old-provider");
    expect(result.error?.code).toBe("provider_not_found");
    expect(result.error?.detail).toContain("Explore subagent failed");
    expect(result.error?.detail).toContain("code=agent_child_runtime_failed");
    expect(result.error?.detail).toContain("provider=old-provider");
    expect(result.error?.detail).toContain("model=old-model");
    expect(stringifyToolResultOutput(result)).toBe(
      "Model provider is not configured: old-provider",
    );
  });

  it("keeps invalid subagent model context in failed parent Agent tool calls", () => {
    const parseError = new Error("Model ref is missing model id");
    const configurationError = createCoreError(
      CoreErrorType.ConfigurationError,
      "Invalid subagent model configuration",
      {
        cause: parseError,
        context: withErrorPayloadRole(
          {
            code: "INVALID_SUBAGENT_MODEL",
            model: "custom:old-provider:",
            reason: "missing_model_id",
          },
          ErrorPayloadRole.Wrapper,
        ),
        recoverable: true,
      },
    );

    const result = createErrorResult(agentToolCall(), configurationError);

    expect(result.error?.message).toBe("Model ref is missing model id");
    expect(result.error?.code).toBe("INVALID_SUBAGENT_MODEL");
    expect(result.error?.detail).toContain("Invalid subagent model configuration");
    expect(result.error?.detail).toContain("model=custom:old-provider:");
    expect(result.error?.detail).toContain("reason=missing_model_id");
  });

  it("preserves plan approval feedback before turn steering handles it", () => {
    const feedback = "x".repeat(600);

    const result = createPermissionErrorResult(
      {
        id: "exit_plan",
        input: { plan: "1. Keep discussing" },
        name: "ExitPlanMode",
      },
      feedback,
      { reasonSource: "plan_approval_feedback" },
    );

    expect(result.error?.message).toBe(feedback);
    expect(result.error?.reasonSource).toBe("plan_approval_feedback");
  });

  it("preserves workflow refine feedback before turn steering handles it", () => {
    const feedback = "改成先跑 lint 再 fan out，".repeat(60);

    const result = createPermissionErrorResult(
      {
        id: "create_workflow",
        input: { script: "return 1;" },
        name: "CreateWorkflow",
      },
      feedback,
      { reasonSource: "workflow_refine_feedback" },
    );

    expect(result.error?.message).toBe(feedback);
    expect(result.error?.reasonSource).toBe("workflow_refine_feedback");
  });
});

function agentToolCall(): ExecutableToolCall {
  return {
    id: "call_agent",
    input: {
      description: "Run stale configured subagent",
      prompt: "Inspect the repo",
      subagent_type: "Explore",
    },
    name: "Agent",
  };
}

describe("ToolExecutor 执行与错误边界", () => {
  it("工具别名执行后返回 canonical tool name", async () => {
    const sessionId = createSessionId("tool-canonical-execution");
    const turnId = createTurnId("turn-canonical-execution");
    const toolCallId = createToolCallId("tool-call-canonical-execution");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register({
      aliases: ["TraceAlias"],
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "TraceCanonical",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        return "ok";
      },
    });
    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: {},
        name: "TraceAlias",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.toolName).toBe("TraceCanonical");
  });

  it("未注册工具的业务错误保留原名", async () => {
    const sessionId = createSessionId("tool-agent-unknown");
    const turnId = createTurnId("turn-agent-unknown");
    const registry = createToolRegistry();
    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
    });

    const result = await executor.execute({
      id: createToolCallId("tool-call-agent-unknown"),
      input: {},
      name: "untrusted-user-derived-tool-name",
    });

    expect(result.success).toBe(false);
    expect(result.toolName).toBe("untrusted-user-derived-tool-name");
  });

  it("语义校验拒绝必须阻止 handler 执行", async () => {
    let handlerCalled = false;
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "SemanticValidationTool",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      validateInput: () => ({
        errorCode: 422,
        message: "semantic input rejected",
        result: false,
      }),
      handler: async () => {
        handlerCalled = true;
        return "unexpected";
      },
    });
    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId: createSessionId("tool-agent-semantic-validation"),
      turnId: createTurnId("turn-agent-semantic-validation"),
    });

    const result = await executor.execute({
      id: createToolCallId("tool-call-agent-semantic-validation"),
      input: {},
      name: "SemanticValidationTool",
    });

    expect(result.success).toBe(false);
    expect(handlerCalled).toBe(false);
  });

  it("进入 handler 前取消返回 ToolCancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before execution"));
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CancelledBeforeHandler",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "unexpected",
    });
    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId: createSessionId("tool-agent-cancelled-before-handler"),
      turnId: createTurnId("turn-agent-cancelled-before-handler"),
    });

    const result = await executor.execute(
      {
        id: createToolCallId("tool-call-agent-cancelled-before-handler"),
        input: {},
        name: "CancelledBeforeHandler",
      },
      { signal: controller.signal },
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.ToolCancelled);
  });

  it("Hook 修改输入后校验失败保留诊断上下文", async () => {
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
        type: "object",
      },
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "HookValidationTool",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "unexpected",
    });
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "hook validation context",
              hookEventName: input.hookEventName,
              updatedInput: {},
            },
          }),
          event: HookEventName.PreToolUse,
          matcher: "HookValidationTool",
        },
      ],
    });
    const executor = createToolExecutor({
      emitEvent: async () => {},
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId: createSessionId("tool-agent-hook-validation"),
      turnId: createTurnId("turn-agent-hook-validation"),
    });

    const result = await executor.execute({
      id: createToolCallId("tool-call-agent-hook-validation"),
      input: { value: "valid-before-hook" },
      name: "HookValidationTool",
    });

    expect(result.success).toBe(false);
    expect(result.modelContent).toContain("hook validation context");
  });

  it("事件发布异常原样向调用方抛出", async () => {
    const failure = new Error("event sink failed");
    const executor = createToolExecutor({
      emitEvent: async () => {
        throw failure;
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: createToolRegistry(),
      sessionId: createSessionId("tool-agent-reject"),
      turnId: createTurnId("turn-agent-reject"),
    });

    await expect(
      executor.execute({
        id: createToolCallId("tool-call-agent-reject"),
        input: {},
        name: "missing-tool",
      }),
    ).rejects.toBe(failure);
  });

  it("取消信号不吞掉事件发布异常", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const executor = createToolExecutor({
      emitEvent: async () => {
        throw new Error("event sink failed after cancellation");
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: createToolRegistry(),
      sessionId: createSessionId("tool-agent-cancelled-reject"),
      turnId: createTurnId("turn-agent-cancelled-reject"),
    });

    await expect(
      executor.execute(
        {
          id: createToolCallId("tool-call-agent-cancelled-reject"),
          input: {},
          name: "missing-tool",
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("event sink failed after cancellation");
  });
});
