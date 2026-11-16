import { z } from "zod";
import { SOURCE_SERVER_CACHE_LOCK_INTERRUPTED_ERROR_CODE } from "./errorCodes.js";

export const SOURCE_SERVER_RELEASE_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;
export const SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME = "source-server-release.json";

export const sourceServerArtifactPolicySchema = z.enum([
  "release-versioned",
  "development-content-addressed",
]);
export type SourceServerArtifactPolicy = z.infer<typeof sourceServerArtifactPolicySchema>;

export const sourceServerReleaseTargetSchema = z.enum(SOURCE_SERVER_RELEASE_TARGETS);
export type SourceServerReleaseTarget = z.infer<typeof sourceServerReleaseTargetSchema>;

/** 仅包含公开发行身份；不能把本机路径、文件名或任意 metadata 加进恢复动作。 */
export const sourceServerCacheRecoverySchema = z
  .object({
    kind: z.literal("source-server-cache-lock"),
    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u,
      ),
    target: sourceServerReleaseTargetSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type SourceServerCacheRecovery = z.infer<typeof sourceServerCacheRecoverySchema>;

/** 公开边界只验证成对字段；Host 的来源证明仍由 resolver 私有 Error 独占。 */
export function parseSourceServerCacheRecovery(
  code: unknown,
  value: unknown,
): SourceServerCacheRecovery | undefined {
  if (code !== SOURCE_SERVER_CACHE_LOCK_INTERRUPTED_ERROR_CODE) return undefined;
  const result = sourceServerCacheRecoverySchema.safeParse(value);
  return result.success ? result.data : undefined;
}

const releaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    if (/^https?:\/\//u.test(value)) return true;
    return (
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }, "Source Server release URL must be HTTP(S) or a safe relative path");

export const sourceServerReleaseArchiveSchema = z
  .object({
    target: sourceServerReleaseTargetSchema,
    version: z.string().trim().min(1),
    fileName: z.string().trim().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sizeBytes: z.number().int().positive(),
    urls: z.array(releaseUrlSchema).min(1),
  })
  .strict()
  .superRefine((archive, context) => {
    const expectedFileName = `zcode-server-${archive.target}.tar.gz`;
    if (archive.fileName !== expectedFileName) {
      context.addIssue({
        code: "custom",
        path: ["fileName"],
        message: `Source Server release fileName must be ${expectedFileName}`,
      });
    }
  });

export type SourceServerReleaseArchive = z.infer<typeof sourceServerReleaseArchiveSchema>;

export const sourceServerReleaseDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().trim().min(1),
    archives: z.array(sourceServerReleaseArchiveSchema).min(1),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const targets = new Set<SourceServerReleaseTarget>();
    descriptor.archives.forEach((archive, index) => {
      if (archive.version !== descriptor.version) {
        context.addIssue({
          code: "custom",
          path: ["archives", index, "version"],
          message: "Source Server archive version must match descriptor version",
        });
      }
      if (targets.has(archive.target)) {
        context.addIssue({
          code: "custom",
          path: ["archives", index, "target"],
          message: `Duplicate Source Server release target: ${archive.target}`,
        });
      }
      targets.add(archive.target);
    });
  });

export type SourceServerReleaseDescriptor = z.infer<typeof sourceServerReleaseDescriptorSchema>;
