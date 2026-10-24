import { randomUUID } from "node:crypto";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProviderRuntimeHeadersResponseSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeAppOptions } from "../app/types.js";
import {
  ProtocolRequestError,
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// 无应答方时 UI 的 SDK 超时不会启动；端口总时限同时覆盖排队与凭据解析。
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS = 180_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32022;
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MESSAGE =
  "Provider runtime headers request timed out. Please send your message again.";

export function createProviderRuntimeHeadersPort(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): NonNullable<ZCodeAppOptions["providerRuntimeHeadersPort"]> {
  return {
    shouldRefreshBeforeModelRequest() {
      return true;
    },
    async refreshBeforeModelRequest(input) {
      const requestId = `${input.sessionId}:provider-runtime-headers:${randomUUID()}`;
      let result;
      try {
        result = await context.requestClient(
          zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
          {
            // 同一毫秒内的并发请求不能共用关联键，否则 pending 应答会覆盖或串用。
            requestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            workspace,
            modelSelection: { providerId: input.providerId, modelId: input.modelId },
            providerId: input.providerId,
            reason: input.reason,
          },
          zcodeProviderRuntimeHeadersResponseSchema,
          {
            signal: input.abortSignal,
            trace: protocolTraceFromTraceContext(input.traceContext),
            timeoutMs: PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS,
          },
        );
      } catch (error) {
        // requestClient abort 只清理 CLI 等待，Host 仍占着凭据解析队列直到超时。
        // 仅此端口发送取消，不改变其他反向 RPC 的生命周期。
        const timedOut =
          error instanceof ProtocolRequestError && error.code === CLIENT_REQUEST_TIMEOUT_CODE;
        // 总时限与主动停止都必须释放 Host；否则 CLI 已失败，旧请求仍会占用队列。
        if (input.abortSignal?.aborted || timedOut) {
          context.notify({
            method: zcodeProtocolNotifications.providerRuntimeHeadersCancelled,
            trace: protocolTraceFromTraceContext(input.traceContext),
            params: { workspace, sessionId: input.sessionId, requestId },
          });
        }
        if (timedOut) {
          const timeoutError = new ProtocolRequestError(
            CLIENT_REQUEST_TIMEOUT_CODE,
            PROVIDER_RUNTIME_HEADERS_TIMEOUT_MESSAGE,
            error.data,
          );
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      }
      if (!result.headersApplied) {
        // runtime header 刷新失败可能来自配置读取失败或凭据缺失；
        // 不能统一改写成单一失败文案，否则会掩盖真实根因并误导重试策略。
        throw new ProtocolRequestError(
          -32031,
          result.errorMessage ??
            "Provider runtime headers were not applied before model request attempt.",
          {
            providerId: input.providerId,
            reason: input.reason,
            workspaceKey: workspace.workspaceKey,
          },
        );
      }
      // 请求凭据独立于 workspace 级 Registry revision，并发刷新不能互相使响应失效。
      return result;
    },
  };
}
