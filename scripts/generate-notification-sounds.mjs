#!/usr/bin/env node
/**
 * 生成任务通知提示音（spec：docs/desktop/task-notification-sounds.md）。
 *
 * 全部由加法 / FM 合成得到，不引入任何第三方采样；输出 22.05 kHz、16-bit PCM 单声道 WAV。
 * 不使用随机数，重复运行得到逐字节一致的文件，便于审阅 diff。
 *
 * 用法：node scripts/generate-notification-sounds.mjs [输出目录]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_RATE = 22_050;
const PEAK = 0.7;
const TAU = Math.PI * 2;

/** 指数衰减包络，attack 秒内线性起音，避免爆音。 */
function envelope(t, { attack = 0.004, decay }) {
  if (t < 0) return 0;
  const rise = attack > 0 ? Math.min(1, t / attack) : 1;
  return rise * Math.exp(-t / decay);
}

function render(durationSeconds, sampleAt) {
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = sampleAt(index / SAMPLE_RATE);
  }
  // 末尾 10ms 线性收尾，保证最后一个采样回到 0。
  const tail = Math.round(0.01 * SAMPLE_RATE);
  for (let index = 0; index < tail; index += 1) {
    samples[length - 1 - index] *= index / tail;
  }
  return samples;
}

function partials(t, frequency, weights) {
  let value = 0;
  for (const [ratio, weight] of weights) value += weight * Math.sin(TAU * frequency * ratio * t);
  return value;
}

/** 五种合成音色；每个函数返回 [-1, 1] 区间外也可，最后统一归一化。 */
export const SOUND_DEFINITIONS = {
  // 清脆：高音钢片感，基音 + 非整数泛音，短促衰减。
  crisp: () =>
    render(
      0.32,
      (t) =>
        envelope(t, { attack: 0.002, decay: 0.07 }) *
        partials(t, 1760, [
          [1, 1],
          [2.76, 0.32],
          [5.4, 0.12],
        ]),
    ),
  // 柔和：中音正弦，较慢起音与长衰减，叠一层低八度。
  soft: () =>
    render(
      0.55,
      (t) =>
        envelope(t, { attack: 0.025, decay: 0.16 }) *
        partials(t, 659.25, [
          [1, 1],
          [0.5, 0.35],
          [2, 0.08],
        ]),
    ),
  // 木鱼：FM 合成的空腔敲击，调制指数随时间快速衰减，音高略微下滑。
  woodblock: () =>
    render(0.2, (t) => {
      const carrier = 520 * (1 - 0.06 * Math.min(1, t / 0.05));
      const index = 3.2 * Math.exp(-t / 0.012);
      const modulator = Math.sin(TAU * carrier * 1.48 * t);
      return (
        envelope(t, { attack: 0.0008, decay: 0.035 }) *
        Math.sin(TAU * carrier * t + index * modulator)
      );
    }),
  // 水滴：正弦音高快速上扫，形成“嘀嗒”气泡感；第二滴更轻。
  droplet: () =>
    render(0.36, (t) => {
      const drop = (start, from, to, gain) => {
        const local = t - start;
        if (local < 0) return 0;
        const sweep = 0.045;
        // 相位为频率积分：线性扫频段 + 之后的恒定频率段。
        const phase =
          local < sweep
            ? from * local + ((to - from) * local * local) / (2 * sweep)
            : from * sweep + ((to - from) * sweep) / 2 + to * (local - sweep);
        return gain * envelope(local, { attack: 0.002, decay: 0.05 }) * Math.sin(TAU * phase);
      };
      return drop(0, 700, 1500, 1) + drop(0.13, 900, 1800, 0.45);
    }),
  // 双音：两个钟声上行（A5 → E6），带少量钟形泛音。
  chime: () =>
    render(0.6, (t) => {
      const bell = (start, frequency, gain) => {
        const local = t - start;
        if (local < 0) return 0;
        return (
          gain *
          envelope(local, { attack: 0.003, decay: 0.14 }) *
          partials(local, frequency, [
            [1, 1],
            [2, 0.22],
            [3.01, 0.08],
          ])
        );
      };
      return bell(0, 880, 0.85) + bell(0.14, 1318.51, 1);
    }),
};

export function encodeWav(samples) {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? PEAK / peak : 0;
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] * scale));
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + index * 2);
  }
  return buffer;
}

export function generateNotificationSounds() {
  return Object.fromEntries(
    Object.entries(SOUND_DEFINITIONS).map(([id, build]) => [id, encodeWav(build())]),
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const outputDirectory = resolve(
    process.argv[2] ??
      join(dirname(scriptPath), "..", "packages", "ui", "src", "assets", "notification-sounds"),
  );
  await mkdir(outputDirectory, { recursive: true });
  for (const [id, buffer] of Object.entries(generateNotificationSounds())) {
    const target = join(outputDirectory, `task-notification-${id}.wav`);
    await writeFile(target, buffer);
    console.log(`${target} (${buffer.length} bytes)`);
  }
}
