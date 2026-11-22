type AppBadgeSetter = (count: number) => void;

export function parseWindowUnreadCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) {
    return null;
  }

  return payload;
}

// 各窗口汇报的未读数已统一为「全局权威树计数」（侧栏蓝点同源），并非窗口私有值：
// 多窗口时所有窗口上报同一个数，取 max 而不是求和，避免未来放开多主窗口时角标翻倍。
export function maxWindowUnreadCounts(windowUnreadCountMap: ReadonlyMap<number, number>): number {
  let maxUnreadCount = 0;

  for (const unreadCount of windowUnreadCountMap.values()) {
    maxUnreadCount = Math.max(maxUnreadCount, unreadCount);
  }

  return maxUnreadCount;
}

// 应用级 badge：macOS Dock / Linux LauncherEntry。spec 见 docs/desktop/windows-taskbar-unread-badge.md
export function supportsAppUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

// Windows 的 app.setBadgeCount 是 no-op，任务栏角标要走窗口级 overlay（setOverlayIcon）。
export function supportsWindowOverlayBadge(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

// 任务栏 overlay 图由主进程自绘，只认字符串文案；0 返回 null 表示移除角标。
export function resolveBadgeOverlayLabel(totalUnreadCount: number): string | null {
  if (!Number.isInteger(totalUnreadCount) || totalUnreadCount <= 0) {
    return null;
  }

  return totalUnreadCount > 9 ? "9+" : String(totalUnreadCount);
}

export function syncUnreadBadgeForPlatform(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
  applyOverlay: (label: string | null) => void;
}): void {
  if (supportsAppUnreadBadge(options.platform)) {
    options.setBadgeCount(options.totalUnreadCount);
    return;
  }

  if (supportsWindowOverlayBadge(options.platform)) {
    options.applyOverlay(resolveBadgeOverlayLabel(options.totalUnreadCount));
  }
}

// ---- 数字徽章像素渲染（纯逻辑，不依赖 electron，便于单测）----
// spec：docs/desktop/windows-taskbar-unread-badge.md（1.5.0 数字徽章）

const BADGE_FILL_COLOR = { red: 229, green: 57, blue: 53 } as const;

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

// 5×7 点阵字体，每行 5 bit，最高位在左；只覆盖角标会用到的字符（1–9、0 与 9+）。
const BADGE_FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  "+": [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
};

export interface CountBadgePixels {
  width: number;
  height: number;
  /** 预乘 alpha 的 BGRA（与 Electron toBitmap / addRepresentation 契约一致）。 */
  pixels: Uint8Array;
}

export interface CountBadgeOptions {
  /** 徽章高度（像素）；单数字时为圆，宽于高度的文案自动拉成胶囊。 */
  height: number;
  /** 5×7 字形的整数放大倍数：1x 表示用 1，2x 表示用 2，保证笔画落在像素网格上。 */
  glyphScale: number;
  /** 文案左右最少留白（像素）。 */
  horizontalPadding?: number;
  /** 宽度下限，例如任务栏 overlay 固定为正方形画布。 */
  minWidth?: number;
  supersample?: number;
}

/**
 * 渲染带数字的红色徽章：白色字形直接落在像素网格上（不做缩放插值，16px 下仍清晰），
 * 红色底为圆/胶囊并用超采样抗锯齿边缘。未知字符不产生字形。
 */
export function renderCountBadgePixels(
  label: string,
  options: CountBadgeOptions,
): CountBadgePixels {
  const glyphs = [...label]
    .map((character) => BADGE_FONT[character])
    .filter((glyph): glyph is number[] => Array.isArray(glyph));
  const scale = options.glyphScale;
  const glyphWidth = GLYPH_WIDTH * scale;
  const glyphHeight = GLYPH_HEIGHT * scale;
  const glyphSpacing = scale;
  const textWidth =
    glyphs.length > 0 ? glyphs.length * glyphWidth + (glyphs.length - 1) * glyphSpacing : 0;
  const height = options.height;
  const width = Math.max(
    height,
    options.minWidth ?? 0,
    textWidth + 2 * (options.horizontalPadding ?? scale),
  );
  const supersample = options.supersample ?? 4;
  const pixels = new Uint8Array(width * height * 4);
  const radius = height / 2;
  const originX = Math.floor((width - textWidth) / 2);
  const originY = Math.floor((height - glyphHeight) / 2);

  const isGlyphPixel = (x: number, y: number): boolean => {
    const localY = y - originY;
    if (localY < 0 || localY >= glyphHeight) return false;
    for (let index = 0; index < glyphs.length; index += 1) {
      const localX = x - originX - index * (glyphWidth + glyphSpacing);
      if (localX < 0 || localX >= glyphWidth) continue;
      const row = glyphs[index]![Math.floor(localY / scale)];
      const column = Math.floor(localX / scale);
      return row !== undefined && ((row >> (GLYPH_WIDTH - 1 - column)) & 1) === 1;
    }
    return false;
  };

  // 胶囊 = 两端半圆 + 中间矩形：采样点到中轴线段的距离 ≤ radius 即在内部。
  const insidePill = (sampleX: number, sampleY: number): boolean => {
    const axisX = Math.min(Math.max(sampleX, radius), width - radius);
    const dx = sampleX - axisX;
    const dy = sampleY - radius;
    return dx * dx + dy * dy <= radius * radius;
  };

  const samplesPerPixel = supersample * supersample;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          if (insidePill(x + (sx + 0.5) / supersample, y + (sy + 0.5) / supersample)) covered += 1;
        }
      }
      if (covered === 0) continue;
      const offset = (y * width + x) * 4;
      if (isGlyphPixel(x, y)) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = 255;
        continue;
      }
      // 预乘 alpha：抗锯齿边缘保持同一红色，不与底图混成白边或脏边。
      const coverage = covered / samplesPerPixel;
      pixels[offset] = Math.round(BADGE_FILL_COLOR.blue * coverage);
      pixels[offset + 1] = Math.round(BADGE_FILL_COLOR.green * coverage);
      pixels[offset + 2] = Math.round(BADGE_FILL_COLOR.red * coverage);
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }

  return { width, height, pixels };
}

/**
 * Windows 任务栏 overlay 固定显示 16×16：scale=1 产出原生 16px，scale=2 产出 32px 高 DPI 表示。
 * 徽章铺满正方形画布（单数字为圆，9+ 两个字形仍在圆内），不再依赖 Win10/Win11 的锚点补偿。
 */
export function renderTaskbarCountBadgePixels(label: string, scale: 1 | 2 = 1): Uint8Array {
  const size = 16 * scale;
  return renderCountBadgePixels(label, {
    height: size,
    minWidth: size,
    glyphScale: scale,
    horizontalPadding: scale,
  }).pixels;
}

/** 托盘图右上角的数字徽章：1x 约 9px 高、2x 约 18px 高，宽于高度时为胶囊。 */
export function renderTrayCountBadgePixels(label: string, scale: 1 | 2 = 1): CountBadgePixels {
  return renderCountBadgePixels(label, {
    height: 9 * scale,
    glyphScale: scale,
    horizontalPadding: scale,
  });
}

// 预乘 alpha 混合：out = src + dst × (1 - srcA)，base 原地修改。越界区域安全裁剪。
export function blendBadgeIntoBitmap(options: {
  base: Uint8Array;
  size: number;
  badge: Uint8Array;
  badgeWidth: number;
  badgeHeight: number;
  originX: number;
  originY: number;
}): void {
  for (let by = 0; by < options.badgeHeight; by += 1) {
    const y = options.originY + by;
    if (y < 0 || y >= options.size) {
      continue;
    }

    for (let bx = 0; bx < options.badgeWidth; bx += 1) {
      const x = options.originX + bx;
      if (x < 0 || x >= options.size) {
        continue;
      }

      const srcOffset = (by * options.badgeWidth + bx) * 4;
      const srcAlpha = options.badge[srcOffset + 3]!;
      if (srcAlpha === 0) {
        continue;
      }

      const dstOffset = (y * options.size + x) * 4;
      if (srcAlpha === 255) {
        options.base[dstOffset] = options.badge[srcOffset]!;
        options.base[dstOffset + 1] = options.badge[srcOffset + 1]!;
        options.base[dstOffset + 2] = options.badge[srcOffset + 2]!;
        options.base[dstOffset + 3] = 255;
        continue;
      }

      const keepRatio = (255 - srcAlpha) / 255;
      for (let channel = 0; channel < 4; channel += 1) {
        const src = options.badge[srcOffset + channel]!;
        const dst = options.base[dstOffset + channel]!;
        options.base[dstOffset + channel] = Math.round(src + dst * keepRatio);
      }
    }
  }
}

// 只要求"有任务栏按钮的窗口"能力，方便单测注入假窗口；
// skipTaskbar 窗口（CUA 指示器等）设置 overlay 无副作用，不必逐一排除。
export type TaskbarOverlayWindow = {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: unknown, description: string): void;
};

export function applyTaskbarOverlayToWindows(options: {
  label: string | null;
  windows: Iterable<TaskbarOverlayWindow>;
  badgeImageForLabel: (label: string) => unknown;
}): void {
  const image = options.label ? options.badgeImageForLabel(options.label) : null;
  const description = options.label ? `${options.label} tasks need attention` : "";

  for (const win of options.windows) {
    if (win.isDestroyed()) {
      continue;
    }

    win.setOverlayIcon(image, description);
  }
}

// 角标只在任务完成/查看任务时变化，更新频率为事件级；徽章图按 label 缓存避免重复渲染。
// electron 侧（BrowserWindow.getAllWindows / nativeImage.createFromBitmap）由 desktopWindowLifecycle 注入。
export function createWindowsTaskbarOverlayApplier(deps: {
  getAllWindows: () => Iterable<TaskbarOverlayWindow>;
  createBadgeImage: (label: string) => unknown;
}): (label: string | null) => void {
  const badgeImageCache = new Map<string, unknown>();

  return (label) => {
    applyTaskbarOverlayToWindows({
      label,
      windows: deps.getAllWindows(),
      badgeImageForLabel: (cachedLabel) => {
        const cachedImage = badgeImageCache.get(cachedLabel);
        if (cachedImage) {
          return cachedImage;
        }

        const image = deps.createBadgeImage(cachedLabel);
        badgeImageCache.set(cachedLabel, image);
        return image;
      },
    });
  };
}
