import type { TaskNotificationSoundCue, TaskNotificationSoundId } from "@zcode/shared";
import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import taskNotificationCrispUrl from "@/assets/notification-sounds/task-notification-crisp.wav";
import taskNotificationSoftUrl from "@/assets/notification-sounds/task-notification-soft.wav";
import taskNotificationWoodblockUrl from "@/assets/notification-sounds/task-notification-woodblock.wav";
import taskNotificationDropletUrl from "@/assets/notification-sounds/task-notification-droplet.wav";
import taskNotificationChimeUrl from "@/assets/notification-sounds/task-notification-chime.wav";
import { getTaskNotificationPreferences } from "@/lib/taskNotificationPreferences.js";

type AudibleSoundId = Exclude<TaskNotificationSoundId, "mute">;

/** pop 沿用原 mp3；其余由 scripts/generate-notification-sounds.mjs 合成并提交。 */
const SOUND_URLS: Record<AudibleSoundId, string> = {
  pop: taskNotificationPopUrl as string,
  crisp: taskNotificationCrispUrl as string,
  soft: taskNotificationSoftUrl as string,
  woodblock: taskNotificationWoodblockUrl as string,
  droplet: taskNotificationDropletUrl as string,
  chime: taskNotificationChimeUrl as string,
};

const audioBySound = new Map<AudibleSoundId, HTMLAudioElement>();

function getAudio(soundId: AudibleSoundId): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  let audio = audioBySound.get(soundId);
  if (!audio) {
    audio = new Audio(SOUND_URLS[soundId]);
    audio.preload = "auto";
    audioBySound.set(soundId, audio);
  }
  return audio;
}

async function playSound(soundId: TaskNotificationSoundId): Promise<void> {
  if (soundId === "mute") {
    return;
  }

  const audio = getAudio(soundId);
  if (!audio) {
    return;
  }

  try {
    // 同一个 Audio 实例在后台通知里反复复用时，若不先回到起点，
    // 新一轮通知经常会因为还停留在上次播放结束态而直接静默。
    // 这里显式重置播放位置，并吞掉自动播放限制异常，避免音效失败反过来影响通知主链路。
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // 音效属于增强体验，播放失败时不打断通知主流程。
  }
}

/** 偏好判定：总开关、类别静音、前台规则。纯函数，便于测试。 */
export function resolveTaskNotificationSound(
  cue: TaskNotificationSoundCue,
  preferences = getTaskNotificationPreferences(),
): TaskNotificationSoundId {
  if (!preferences.enabled) return "mute";
  if (cue.appFocused && !preferences.playWhenFocused) return "mute";
  return cue.category === "completed" ? preferences.completedSound : preferences.attentionSound;
}

/**
 * Desktop/Web 平台层在通知意图被接受后调用；这里是是否发声的唯一判定点，
 * 平台层只提供类别与“应用是否在前台”，不读取偏好。
 */
export async function playTaskNotificationSound(cue: TaskNotificationSoundCue): Promise<void> {
  await playSound(resolveTaskNotificationSound(cue));
}

/** 设置页试听：按指定音色直接播放，不受总开关与前台规则限制。 */
export async function previewTaskNotificationSound(
  soundId: TaskNotificationSoundId,
): Promise<void> {
  await playSound(soundId);
}
