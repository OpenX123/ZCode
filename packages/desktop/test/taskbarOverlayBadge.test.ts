import { describe, expect, it, vi } from "vitest";
import {
  applyTaskbarOverlayToWindows,
  blendBadgeIntoBitmap,
  createWindowsTaskbarOverlayApplier,
  renderCountBadgePixels,
  renderTaskbarCountBadgePixels,
  renderTrayCountBadgePixels,
} from "../src/main/unreadBadge.js";
import type { TaskbarOverlayWindow } from "../src/main/unreadBadge.js";

const FILL_RED_BGRA = [53, 57, 229, 255];
const WHITE_BGRA = [255, 255, 255, 255];

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

function whiteColumns(pixels: Uint8Array, width: number, height: number): Set<number> {
  const columns = new Set<number>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixelAt(pixels, width, x, y).every((value) => value === 255)) columns.add(x);
    }
  }
  return columns;
}

function countWhitePixels(pixels: Uint8Array): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (
      pixels[offset] === 255 &&
      pixels[offset + 1] === 255 &&
      pixels[offset + 2] === 255 &&
      pixels[offset + 3] === 255
    ) {
      count += 1;
    }
  }
  return count;
}

function createFakeWindow(options: { destroyed?: boolean } = {}): TaskbarOverlayWindow & {
  overlays: Array<{ image: unknown; description: string }>;
} {
  const overlays: Array<{ image: unknown; description: string }> = [];
  return {
    isDestroyed: () => Boolean(options.destroyed),
    setOverlayIcon: (image, description) => {
      overlays.push({ image, description });
    },
    overlays,
  };
}

describe("windows taskbar overlay badge", () => {
  describe("renderTaskbarCountBadgePixels（1.5.0 数字徽章）", () => {
    it.each([1, 2] as const)("%ix 表示铺满 16·scale 正方形画布", (scale) => {
      const size = 16 * scale;
      const pixels = renderTaskbarCountBadgePixels("3", scale);
      expect(pixels.length).toBe(size * size * 4);
      // 圆心附近是不透明的红/白，四角在圆外完全透明（预乘后全 0）
      expect(pixelAt(pixels, size, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(pixelAt(pixels, size, size - 1, size - 1)).toEqual([0, 0, 0, 0]);
      expect(pixelAt(pixels, size, 1, size / 2)[3]).toBeGreaterThan(0);
    });

    it.each(["1", "2", "3", "4", "5", "6", "7", "8", "9", "9+"])(
      "%s 在 16px 与 32px 下都有白色字形且居中",
      (label) => {
        for (const scale of [1, 2] as const) {
          const size = 16 * scale;
          const pixels = renderTaskbarCountBadgePixels(label, scale);
          expect(countWhitePixels(pixels)).toBeGreaterThan(4 * scale);
          const columns = [...whiteColumns(pixels, size, size)];
          const left = Math.min(...columns);
          const right = size - 1 - Math.max(...columns);
          // 左右留白差不超过 1 个字形像素，视觉居中
          expect(Math.abs(left - right)).toBeLessThanOrEqual(scale);
        }
      },
    );

    it("9+ 的两个字形之间留出一列红色间隙，不粘连", () => {
      for (const scale of [1, 2] as const) {
        const size = 16 * scale;
        const columns = whiteColumns(renderTaskbarCountBadgePixels("9+", scale), size, size);
        const sorted = [...columns].sort((a, b) => a - b);
        const gaps = sorted.slice(1).filter((column, index) => column - sorted[index]! > 1);
        expect(gaps.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("非字形区域是纯红，字形是纯白", () => {
      const pixels = renderTaskbarCountBadgePixels("1", 1);
      const all = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] === 255)
          all.add(String(Array.from(pixels.slice(offset, offset + 4))));
      }
      expect(all).toEqual(new Set([String(FILL_RED_BGRA), String(WHITE_BGRA)]));
    });

    it("边缘使用半透明抗锯齿像素", () => {
      const pixels = renderTaskbarCountBadgePixels("1", 1);
      let partial = 0;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if (pixels[offset]! > 0 && pixels[offset]! < 255) partial += 1;
      }
      expect(partial).toBeGreaterThan(0);
    });

    it("未知字符不产生字形，只剩红底", () => {
      expect(countWhitePixels(renderTaskbarCountBadgePixels("x", 1))).toBe(0);
    });
  });

  describe("renderTrayCountBadgePixels", () => {
    it("单数字为 9px 高的圆，9+ 拉成更宽的胶囊", () => {
      expect(renderTrayCountBadgePixels("3", 1)).toMatchObject({ width: 9, height: 9 });
      const wide = renderTrayCountBadgePixels("9+", 1);
      expect(wide.height).toBe(9);
      expect(wide.width).toBeGreaterThan(9);
      expect(renderTrayCountBadgePixels("9+", 2).height).toBe(18);
    });

    it("胶囊两端圆角透明，中间是数字", () => {
      const badge = renderCountBadgePixels("9+", { height: 9, glyphScale: 1 });
      expect(pixelAt(badge.pixels, badge.width, 0, 0)[3]).toBe(0);
      expect(pixelAt(badge.pixels, badge.width, badge.width - 1, 0)[3]).toBe(0);
      expect(countWhitePixels(badge.pixels)).toBeGreaterThan(10);
    });
  });

  describe("applyTaskbarOverlayToWindows", () => {
    it("把角标图和描述同步到所有存活窗口", () => {
      const winA = createFakeWindow();
      const winB = createFakeWindow();
      const image = { __badge: true };

      applyTaskbarOverlayToWindows({
        label: "3",
        windows: [winA, winB],
        badgeImageForLabel: () => image,
      });

      expect(winA.overlays).toEqual([{ image, description: "3 tasks need attention" }]);
      expect(winB.overlays).toEqual([{ image, description: "3 tasks need attention" }]);
    });

    it("label 为 null 时清除 overlay 且不生成徽章图", () => {
      const win = createFakeWindow();
      const badgeImageForLabel = vi.fn();

      applyTaskbarOverlayToWindows({
        label: null,
        windows: [win],
        badgeImageForLabel,
      });

      expect(win.overlays).toEqual([{ image: null, description: "" }]);
      expect(badgeImageForLabel).not.toHaveBeenCalled();
    });

    it("跳过已销毁的窗口", () => {
      const alive = createFakeWindow();
      const destroyed = createFakeWindow({ destroyed: true });

      applyTaskbarOverlayToWindows({
        label: "1",
        windows: [destroyed, alive],
        badgeImageForLabel: () => ({ __badge: true }),
      });

      expect(destroyed.overlays).toHaveLength(0);
      expect(alive.overlays).toHaveLength(1);
    });
  });

  describe("createWindowsTaskbarOverlayApplier", () => {
    it("遍历注入的全部窗口并按 label 缓存徽章图", () => {
      const winA = createFakeWindow();
      const winB = createFakeWindow();
      const createBadgeImage = vi.fn(() => ({ __badge: true }));
      const applier = createWindowsTaskbarOverlayApplier({
        getAllWindows: () => [winA, winB],
        createBadgeImage,
      });

      applier("2");
      applier("2");

      expect(createBadgeImage).toHaveBeenCalledTimes(1);
      expect(createBadgeImage).toHaveBeenCalledWith("2");
      const expectedImage = { __badge: true };
      expect(winA.overlays).toEqual([
        { image: expectedImage, description: "2 tasks need attention" },
        { image: expectedImage, description: "2 tasks need attention" },
      ]);
      expect(winB.overlays).toHaveLength(2);
    });

    it("label 为 null 时对所有窗口下发 null 清除角标", () => {
      const win = createFakeWindow();
      const applier = createWindowsTaskbarOverlayApplier({
        getAllWindows: () => [win],
        createBadgeImage: vi.fn(),
      });

      applier(null);

      expect(win.overlays).toEqual([{ image: null, description: "" }]);
    });
  });

  describe("blendBadgeIntoBitmap", () => {
    const SIZE = 4;

    function fillBase(): Uint8Array {
      // 4×4 不透明蓝底（预乘 BGRA：B=200, G=40, R=10, A=255）
      const base = new Uint8Array(SIZE * SIZE * 4);
      for (let offset = 0; offset < base.length; offset += 4) {
        base[offset] = 200;
        base[offset + 1] = 40;
        base[offset + 2] = 10;
        base[offset + 3] = 255;
      }
      return base;
    }

    function solidBadge(value: { b: number; g: number; r: number; a: number }): Uint8Array {
      const badge = new Uint8Array(2 * 2 * 4);
      for (let offset = 0; offset < badge.length; offset += 4) {
        badge[offset] = value.b;
        badge[offset + 1] = value.g;
        badge[offset + 2] = value.r;
        badge[offset + 3] = value.a;
      }
      return badge;
    }

    function pixel(buffer: Uint8Array, x: number, y: number): number[] {
      const offset = (y * SIZE + x) * 4;
      return [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!];
    }

    it("不透明徽章完全覆盖目标区域，其余像素不受影响", () => {
      const base = fillBase();
      blendBadgeIntoBitmap({
        base,
        size: SIZE,
        badge: solidBadge({ b: 1, g: 2, r: 3, a: 255 }),
        badgeWidth: 2,
        badgeHeight: 2,
        originX: 2,
        originY: 2,
      });

      expect(pixel(base, 2, 2)).toEqual([1, 2, 3, 255]);
      expect(pixel(base, 3, 3)).toEqual([1, 2, 3, 255]);
      expect(pixel(base, 0, 0)).toEqual([200, 40, 10, 255]);
      expect(pixel(base, 1, 1)).toEqual([200, 40, 10, 255]);
    });

    it("半透明徽章按预乘 alpha 混合：out = src + dst × (1 - srcA)", () => {
      const base = fillBase();
      // srcA = 128 → keep ≈ 0.498；out.b = 100 + 200 × 0.498039 ≈ 200（四舍五入）
      blendBadgeIntoBitmap({
        base,
        size: SIZE,
        badge: solidBadge({ b: 100, g: 0, r: 0, a: 128 }),
        badgeWidth: 2,
        badgeHeight: 2,
        originX: 0,
        originY: 0,
      });

      const [b, g, r, a] = pixel(base, 0, 0);
      expect(a).toBe(255);
      expect(b).toBe(Math.round(100 + 200 * ((255 - 128) / 255)));
      expect(g).toBe(Math.round(0 + 40 * ((255 - 128) / 255)));
      expect(r).toBe(Math.round(0 + 10 * ((255 - 128) / 255)));
    });

    it("徽章透明像素（a=0）不改动底图，越界区域安全裁剪", () => {
      const base = fillBase();
      const badge = new Uint8Array(2 * 2 * 4); // 全透明
      badge[3] = 0;
      blendBadgeIntoBitmap({
        base,
        size: SIZE,
        badge,
        badgeWidth: 2,
        badgeHeight: 2,
        originX: 3,
        originY: 3, // 2×2 徽章只有 (3,3) 落在画布内，(4,3)(3,4)(4,4) 越界
      });

      expect(pixel(base, 0, 0)).toEqual([200, 40, 10, 255]);
      expect(pixel(base, 3, 3)).toEqual([200, 40, 10, 255]);
    });
  });
});
