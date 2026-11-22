import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// 仓库根脚本为无类型声明的 .mjs；按文件 URL 动态导入并收窄到用到的导出。
const scriptUrl = pathToFileURL(
  join(import.meta.dirname, "..", "..", "..", "scripts", "generate-notification-sounds.mjs"),
).href;
const { SAMPLE_RATE, generateNotificationSounds } = (await import(scriptUrl)) as {
  SAMPLE_RATE: number;
  generateNotificationSounds: () => Record<string, Buffer>;
};

const assetsDirectory = join(import.meta.dirname, "..", "src", "assets", "notification-sounds");
const SOUND_IDS = ["crisp", "soft", "woodblock", "droplet", "chime"];

describe("通知提示音合成脚本", () => {
  const generated = generateNotificationSounds();

  it("生成五种音色：清脆、柔和、木鱼、水滴、双音", () => {
    expect(Object.keys(generated).sort()).toEqual([...SOUND_IDS].sort());
  });

  it.each(SOUND_IDS)("%s 为合法 16-bit 单声道 WAV，时长 ≤ 0.6s、体积 ≤ 30KB", (id) => {
    const wav = generated[id]!;
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40) / 2 / SAMPLE_RATE).toBeLessThanOrEqual(0.6);
    expect(wav.length).toBeLessThanOrEqual(30 * 1024);
  });

  it("输出确定：提交的资源与脚本重新生成的字节一致", async () => {
    for (const [id, buffer] of Object.entries(generated)) {
      const committed = await readFile(join(assetsDirectory, `task-notification-${id}.wav`));
      expect(committed.equals(buffer), id).toBe(true);
    }
  });
});
