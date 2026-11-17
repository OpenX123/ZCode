import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { Client } from "ssh2";
import { providerProvisioningResultSchema } from "@zcode/shared";
import type { SSHConnectionConfig } from "./ssh-remote-p0.js";
import { parseProvisioningSyncEvents } from "./provisioning-sync-evidence.js";

export interface ProvisioningJournalBaseline {
  readonly home: string;
  readonly appliedSyncIds: readonly string[];
  readonly initialRead: "present" | "missing";
}

export interface ProvisioningJournalSettlement {
  readonly environmentKey: string;
  readonly baselineAppliedSyncIds: readonly string[];
  readonly appliedSyncIds: readonly string[];
  readonly newAppliedSyncIds: readonly string[];
  readonly mainAppliedCount: number;
  readonly settled: boolean;
}

class JournalEvidenceError extends Error {
  constructor(code: string) {
    super(`Provisioning journal evidence: ${code}`);
  }
}

function evidenceError(code: string): JournalEvidenceError {
  return new JournalEvidenceError(code);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === 2 || error.code === "ENOENT")
  );
}

async function readSftpJournal(
  client: Client,
  initial: boolean,
): Promise<ProvisioningJournalBaseline> {
  const home = await readAuthenticatedHome(client);
  const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
    client.sftp((error, value) =>
      error ? reject(evidenceError("sftp-open-failed")) : resolve(value),
    );
  });
  // 已安装 ssh2 的 HOME 扩展编码会覆盖扩展名；固定 printf 取认证 HOME 后，
  // 仅使用标准 realpath 校验绝对路径，不猜 cwd/用户名，也不修改依赖或回退路径。
  const canonicalHome = await new Promise<string>((resolve, reject) => {
    sftp.realpath(home, (error, value) =>
      error ? reject(evidenceError("sftp-realpath-failed")) : resolve(value),
    );
  });
  if (canonicalHome !== home) throw evidenceError("home-realpath-mismatch");
  const text = await new Promise<string | null>((resolve, reject) => {
    sftp.readFile(
      posix.join(home, ".zcode/v2/runtime/provider/provisioning.json"),
      (error, data) => {
        if (!error) resolve(data.toString("utf8"));
        else if (initial && isMissingFile(error)) resolve(null);
        else
          reject(evidenceError(isMissingFile(error) ? "journal-missing" : "journal-read-failed"));
      },
    );
  });
  if (text === null) return { home, appliedSyncIds: [], initialRead: "missing" };
  try {
    const journal: unknown = JSON.parse(text);
    if (
      !journal ||
      typeof journal !== "object" ||
      !("schemaVersion" in journal) ||
      journal.schemaVersion !== 1 ||
      !("records" in journal) ||
      !Array.isArray(journal.records) ||
      Object.keys(journal).some((key) => key !== "schemaVersion" && key !== "records")
    ) {
      throw evidenceError("invalid-records");
    }
    const seen = new Set<string>();
    const appliedSyncIds = journal.records.flatMap((record) => {
      if (
        !record ||
        typeof record !== "object" ||
        typeof record.syncId !== "string" ||
        !record.syncId.trim() ||
        seen.has(record.syncId) ||
        Object.keys(record).some((key) => key !== "syncId" && key !== "result")
      ) {
        throw evidenceError("invalid-record");
      }
      seen.add(record.syncId);
      const result = providerProvisioningResultSchema.parse(record.result);
      if (result.syncId !== record.syncId) throw evidenceError("record-result-id-mismatch");
      return result.status === "applied" ? [record.syncId] : [];
    });
    return { home, appliedSyncIds, initialRead: "present" };
  } catch {
    throw evidenceError("invalid-journal");
  }
}

function readAuthenticatedHome(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(`printf '%s' "$HOME"`, (error, channel) => {
      if (error) {
        reject(evidenceError("home-exec-failed"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let finished = false;
      const fail = (code: string) => {
        if (finished) return;
        finished = true;
        reject(evidenceError(code));
      };
      channel.once("error", () => fail("home-command-failed"));
      channel.stderr.once("error", () => fail("home-command-failed"));
      channel.stderr.resume();
      channel.on("data", (data: Buffer | string) => {
        if (finished) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        bytes += chunk.length;
        if (bytes > 4096) {
          fail("invalid-home");
          return;
        }
        chunks.push(chunk);
      });
      channel.once("close", (code: number | null, signal?: string) => {
        if (finished) return;
        if (code !== 0 || signal) {
          fail("home-command-failed");
          return;
        }
        const raw = Buffer.concat(chunks);
        const home = raw.toString("utf8");
        if (
          !home ||
          !Buffer.from(home, "utf8").equals(raw) ||
          !posix.isAbsolute(home) ||
          posix.normalize(home) !== home ||
          raw.some((byte) => byte < 32 || byte === 127)
        ) {
          fail("invalid-home");
          return;
        }
        finished = true;
        resolve(home);
      });
    });
  });
}

async function readJournal(
  config: SSHConnectionConfig,
  initial: boolean,
): Promise<ProvisioningJournalBaseline> {
  const client = new Client();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("error", reject);
        client.once("ready", resolve);
        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          readyTimeout: 30_000,
        });
      });
    } catch {
      throw evidenceError("ssh-connect-failed");
    }
    // 沿用 runSSHCommand 的单个 60 秒控制边界，覆盖 exec ACK/data/close 和全部 SFTP；
    // 超时销毁本次只读连接，不增加业务同步等待，也不重试旧 RPC。
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(evidenceError("sftp-read-timeout"));
        client.destroy();
      }, 60_000);
    });
    return await Promise.race([readSftpJournal(client, initial), deadline]);
  } catch (error) {
    if (error instanceof JournalEvidenceError) throw error;
    throw evidenceError("sftp-protocol-failed");
  } finally {
    clearTimeout(timer);
    client.end();
  }
}

/** 必须在首次 Desktop 目标连接之前调用；只保存可公开的 HOME 身份和 applied ID。 */
export function captureProvisioningJournalBaseline(config: SSHConnectionConfig) {
  return readJournal(config, true);
}

/** GUI hold 前的实际读取接缝：完整本轮 Main 日志与目标 journal。 */
export async function readProvisioningJournalSettlement(options: {
  config: SSHConnectionConfig;
  baseline: ProvisioningJournalBaseline;
  environmentKey: string;
  logDirectory: string;
}): Promise<ProvisioningJournalSettlement> {
  const current = await readJournal(options.config, false);
  if (current.home !== options.baseline.home) throw evidenceError("home-changed");
  const currentIds = new Set(current.appliedSyncIds);
  const baselineIds = new Set(options.baseline.appliedSyncIds);
  if (options.baseline.appliedSyncIds.some((id) => !currentIds.has(id))) {
    throw evidenceError("baseline-not-retained");
  }
  let mainAppliedCount: number;
  try {
    const files = (await readdir(options.logDirectory))
      .filter((name) => name.endsWith(".log"))
      .sort();
    const logs = await Promise.all(
      files.map((name) => readFile(join(options.logDirectory, name), "utf8")),
    );
    mainAppliedCount = logs
      .flatMap(parseProvisioningSyncEvents)
      .filter(
        (event) => event.environmentKey === options.environmentKey && event.status === "applied",
      ).length;
  } catch {
    throw evidenceError("main-log-invalid-or-unreadable");
  }
  // journal 属于持久化 Target，Main 日志只属于当前 run；不能拿全部历史提交数对账。
  // Main 没有 syncId：精确数值相等仍不能排除一漏一重抵消，不声称逐笔双射。
  const newAppliedSyncIds = current.appliedSyncIds.filter((id) => !baselineIds.has(id));
  return {
    environmentKey: options.environmentKey,
    baselineAppliedSyncIds: [...options.baseline.appliedSyncIds],
    appliedSyncIds: [...current.appliedSyncIds],
    newAppliedSyncIds,
    mainAppliedCount,
    settled: newAppliedSyncIds.length > 0 && mainAppliedCount === newAppliedSyncIds.length,
  };
}
