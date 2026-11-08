import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  botsConfigFileSchema,
  botsStateFileSchema,
  type BotsConfigFile,
  type BotsStateFile,
  type BotContextState,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import {
  BOTS_CONFIG_FILE,
  BOTS_LEGACY_CONFIG_FILE,
  BOTS_LEGACY_STATE_FILE,
  BOTS_V2_STATE_FILE,
  BOTS_STATE_FILE,
  createDefaultBotsConfig,
} from "./config.js";
import { importLegacyBotConfig, importLegacyBotState } from "./storageMigration.js";

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isTransientReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWritePrivateTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class BotsRepo {
  private readonly configDir = getAppConfigDir();
  async readConfig(): Promise<BotsConfigFile> {
    const path = join(this.configDir, BOTS_CONFIG_FILE);
    return withFileLock(path, async () => {
      const current = await readOptionalJson(path);
      // 回滚兼容：v3 已存在就只认 v3；损坏时暴露错误，绝不能恢复旧 Bot 或覆盖用户新修改。
      if (current !== undefined) return botsConfigFileSchema.parse(current);
      const legacy = await readOptionalJson(join(this.configDir, BOTS_LEGACY_CONFIG_FILE));
      const config = botsConfigFileSchema.parse(
        legacy === undefined ? createDefaultBotsConfig() : importLegacyBotConfig(legacy),
      );
      await writeJson(path, config);
      return config;
    });
  }

  async writeConfig(config: BotsConfigFile): Promise<BotsConfigFile> {
    const parsed = botsConfigFileSchema.parse(config);
    const path = join(this.configDir, BOTS_CONFIG_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }

  async readState(): Promise<BotsStateFile> {
    const path = join(this.configDir, BOTS_STATE_FILE);
    return withFileLock(path, () => this.readStateUnlocked(path));
  }

  /**
   * 只读快照：不进入文件锁。
   *
   * 修复原因（2026-11-08 本机扫描）：窗口打开时 12 次 getBotStates 与 10 秒私聊恢复轮询都对
   * 33 字节的 bot-state.v3.json 走完整文件锁（进程内 FIFO + 目录锁创建/删除），并发读取排成
   * 0.21→1.94s 阶梯，没有机器人时也每 10 秒创建删除一次 .lock。
   *
   * 依据：本文件的全部写入（writeState / updateContext / 迁移）都在锁内经
   * atomicWritePrivateTextFile 以"同目录临时文件写完 → rename 覆盖"原子替换，读者只能看到替换前
   * 或替换后的完整内容，不存在半写；锁只用于写-写互斥与读改写原子性，纯读取不需要。
   * 只给不写回的路径使用；读后写回的路径仍用 readState，避免扩大丢失更新窗口。
   */
  async readStateSnapshot(): Promise<BotsStateFile> {
    const path = join(this.configDir, BOTS_STATE_FILE);
    let current: unknown;
    try {
      current = await readOptionalJson(path);
    } catch (error) {
      // Windows 上读取恰好撞上 rename 替换窗口会得到瞬时占用错误；锁内不会与写入并发，回到加锁读取。
      if (isTransientReplaceError(error)) return this.readState();
      throw error;
    }
    // v3 尚不存在说明需要迁移或首次创建：迁移结果必须在文件锁内固定，走原加锁路径。
    if (current === undefined) return this.readState();
    return botsStateFileSchema.parse(current);
  }

  private async readStateUnlocked(path: string): Promise<BotsStateFile> {
    const current = await readOptionalJson(path);
    if (current !== undefined) return botsStateFileSchema.parse(current);
    const v2 = await readOptionalJson(join(this.configDir, BOTS_V2_STATE_FILE));
    const legacy =
      v2 === undefined ? await readOptionalJson(join(this.configDir, BOTS_LEGACY_STATE_FILE)) : v2;
    const state = botsStateFileSchema.parse(
      legacy === undefined ? { version: 3, bots: {} } : importLegacyBotState(legacy),
    );
    // 在同一文件锁内固定迁移结果；后续登录/套餐变化不再重新解释旧身份。
    await writeJson(path, state);
    return state;
  }

  /** 锁覆盖完整读改写，避免两个 Bot 或 provider cursor 覆盖其他 context。 */
  async updateContext(
    botId: string,
    update: (current: BotContextState | undefined) => BotContextState | undefined,
  ): Promise<BotContextState | undefined> {
    const path = join(this.configDir, BOTS_STATE_FILE);
    return withFileLock(path, async () => {
      const state = await this.readStateUnlocked(path);
      const next = update(state.bots[botId]);
      if (next) state.bots[botId] = next;
      else delete state.bots[botId];
      const parsed = botsStateFileSchema.parse(state);
      await writeJson(path, parsed);
      return parsed.bots[botId];
    });
  }

  async writeState(state: BotsStateFile): Promise<BotsStateFile> {
    const parsed = botsStateFileSchema.parse(state);
    const path = join(this.configDir, BOTS_STATE_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }
}
