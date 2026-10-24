/* eslint-disable max-lines -- Provisioning target keeps transaction and rollback invariants together. */
import {
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  providerProvisioningEnvelopeSchema,
  providerProvisioningResultSchema,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningErrorCode,
  type ProviderProvisioningResult,
} from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { readFile } from "node:fs/promises";
import type { IProviderProvisioningTargetService } from "./providerProvisioning.js";
import { readProvisionablePersonalConfig } from "./providerProvisioningSource.js";
import type { ProviderRuntime } from "./providerRuntime.js";

const PROVISIONING_SCHEMA_VERSION = 1 as const;

export interface ProviderProvisioningTargetOptions {
  readonly providerRuntime: ProviderRuntime;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly personalConfigFilePath: string;
  readonly stateFilePath: string;
}

interface ProvisioningStateRecord {
  readonly syncId: string;
  readonly result: ProviderProvisioningResult;
}

interface ProvisioningStateFile {
  readonly schemaVersion: typeof PROVISIONING_SCHEMA_VERSION;
  readonly records: readonly ProvisioningStateRecord[];
}

/** 运行在目标 Environment 内的 Provisioning target；负责写正式 Store 并在失败时回滚。 */
export function createProviderProvisioningTarget(
  options: ProviderProvisioningTargetOptions,
): IProviderProvisioningTargetService {
  return {
    async apply(input: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult> {
      const envelope = providerProvisioningEnvelopeSchema.parse(input);
      return withFileLock(options.stateFilePath, async () => {
        const previousState = await readStateFile(options.stateFilePath);
        const previousResult = previousState?.records.find(
          (record) => record.syncId === envelope.syncId,
        );
        if (previousResult) {
          return {
            ...previousResult.result,
            status: "already-applied",
          } satisfies ProviderProvisioningResult;
        }

        validateCredentialEntries(envelope);
        // schema v1 接受旧 Source 的账号 Key 字段，但新 Host 不再读取或应用它。
        // 旧/手工 Key 留在原 Store，避免升级同步误删其它客户端共享的凭据。

        await options.providerRuntime.start();
        const before = await captureBeforeState(options);
        const personalUpdate = parsePersonalConfig(envelope);
        const applied: AppliedProvisioningState = {
          personalConfig: false,
          personalConfigExpected: personalUpdate,
        };

        let errorCode: ProviderProvisioningErrorCode = "target-write-failed";
        try {
          applied.personalConfig = true;
          await options.personalRepository.update((current) => {
            // 其他域写入期间 Personal 可能已被编辑；检查与替换必须在同一个文件锁内。
            if (!samePersonalConfig(current, before.personal)) {
              throw new Error("Personal Provider Config 在同步期间被其它操作修改");
            }
            return personalUpdate;
          });

          errorCode = "target-refresh-failed";
          const snapshot =
            await options.providerRuntime.registryService.refresh("provider-provisioning");
          // 失效默认只是新会话偏好；把它当同步硬条件会让正常 SSH 被旧模型/档位阻断。
          // 原样保留偏好，由 Host 现有推荐逻辑解析；真实写入/刷新失败仍按事务回滚。

          const result = {
            syncId: envelope.syncId,
            status: "applied" as const,
            personalProviderCount: personalUpdate.providers.keys().length,
            credentialCount: 0,
            configRevision: snapshot.sourceRevisions.config,
            rolledBack: false,
          } satisfies ProviderProvisioningResult;
          errorCode = "target-commit-failed";
          await writeStateFile(options.stateFilePath, appendStateRecord(previousState, result));
          return result;
        } catch (error) {
          // 回滚前对每个 domain 做 CAS 式校验；若期间已有其它写入，宁可报告
          // rollback_failed，也不能用过期快照覆盖或删除用户的新配置。
          const rollbackError = await rollback(before, applied, options);
          if (rollbackError) {
            return {
              syncId: envelope.syncId,
              status: "rollback_failed",
              personalProviderCount: before.personal.providers.keys().length,
              credentialCount: 0,
              errorMessage: `${formatError(error)}；回滚失败：${formatError(rollbackError)}`,
              errorCode,
              rolledBack: false,
            } satisfies ProviderProvisioningResult;
          }
          return {
            syncId: envelope.syncId,
            status: "failed",
            personalProviderCount: before.personal.providers.keys().length,
            credentialCount: 0,
            errorMessage: formatError(error),
            errorCode,
            rolledBack: true,
          } satisfies ProviderProvisioningResult;
        }
      });
    },
  };
}

interface BeforeState {
  readonly personal: ProviderConfigLayerUpdate;
}

interface AppliedProvisioningState {
  personalConfig: boolean;
  personalConfigExpected: ProviderConfigLayerUpdate;
}

function parsePersonalConfig(envelope: ProviderProvisioningEnvelope): ProviderConfigLayerUpdate {
  // 信封与本地保存复用正式 Personal codec，不在接收端另建字段清单或模式判断。
  return decodeProviderConfigFile({ schemaVersion: 1, config: envelope.personalConfig });
}

async function captureBeforeState(
  options: ProviderProvisioningTargetOptions,
): Promise<BeforeState> {
  return {
    personal: await readProvisionablePersonalConfig(
      options.personalRepository,
      options.personalConfigFilePath,
    ),
  };
}

async function rollback(
  before: BeforeState,
  applied: AppliedProvisioningState,
  options: ProviderProvisioningTargetOptions,
): Promise<Error | undefined> {
  const errors: unknown[] = [];
  if (applied.personalConfig) {
    try {
      await options.personalRepository.update((current) => {
        if (samePersonalConfig(current, before.personal)) return current;
        if (!samePersonalConfig(current, applied.personalConfigExpected)) {
          throw new Error("Personal Provider Config 在同步期间被其它操作修改，跳过回滚");
        }
        // 默认选择与 Provider/Model 共用一份 CAS；不能分别回滚制造混合状态或覆盖新选择。
        return before.personal;
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    return new Error(errors.map(formatError).join("；"));
  }
  try {
    await options.providerRuntime.registryService.refresh("provider-provisioning-rollback");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

function samePersonalConfig(
  left: ProviderConfigLayerUpdate,
  right: ProviderConfigLayerUpdate,
): boolean {
  return (
    JSON.stringify(encodeProviderConfigFile(left)) ===
    JSON.stringify(encodeProviderConfigFile(right))
  );
}

function validateCredentialEntries(envelope: ProviderProvisioningEnvelope): void {
  // 兼容旧信封字段，但既不读取也不写入其中的官方凭据和账号设置。
  const seen = new Set<string>();
  for (const entry of envelope.credentials) {
    if (seen.has(entry.key)) throw new Error(`重复 Provisioning Credential key: ${entry.key}`);
    seen.add(entry.key);
  }
}

async function readStateFile(filePath: string): Promise<ProvisioningStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== PROVISIONING_SCHEMA_VERSION) {
      return null;
    }
    const rawRecords = Array.isArray(parsed.records)
      ? parsed.records
      : parsed.syncId && parsed.result
        ? [{ syncId: parsed.syncId, result: parsed.result }]
        : [];
    const records = rawRecords.flatMap((record) => {
      if (typeof record !== "object" || record === null) return [];
      const candidate = record as Record<string, unknown>;
      if (typeof candidate.syncId !== "string" || !candidate.syncId.trim()) return [];
      const result = providerProvisioningResultSchema.safeParse(candidate.result);
      return result.success ? [{ syncId: candidate.syncId, result: result.data }] : [];
    });
    return { schemaVersion: PROVISIONING_SCHEMA_VERSION, records };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return null;
  }
}

function appendStateRecord(
  previousState: ProvisioningStateFile | null,
  result: ProviderProvisioningResult,
): ProvisioningStateFile {
  const records = [
    ...(previousState?.records ?? []).filter((record) => record.syncId !== result.syncId),
    { syncId: result.syncId, result },
  ];
  return {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    records,
  };
}

function writeStateFile(filePath: string, state: ProvisioningStateFile): Promise<void> {
  return atomicWritePrivateTextFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
