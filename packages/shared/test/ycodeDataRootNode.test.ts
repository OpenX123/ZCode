import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearYCodeDataRootCache,
  migrateLegacyDataDirSync,
  nodeDataDirMigrationFs,
  resolveYCodeDataRoot,
  type DataDirMigrationFs,
} from "../src/ycode-data-root/index.js";

// 所有用例只操作 mkdtemp 下的临时目录，不触碰真实 ~/.zcode / ~/.ycode。
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ycode-data-root-"));
  clearYCodeDataRootCache();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearYCodeDataRootCache();
});

function seedLegacy(dirName = ".zcode"): void {
  mkdirSync(join(base, dirName, "v2"), { recursive: true });
  writeFileSync(join(base, dirName, "v2", "setting.json"), '{"locale":"zh-CN"}');
}

describe("resolveYCodeDataRoot", () => {
  it("returns the legacy dir while unmigrated, .ycode otherwise", () => {
    expect(resolveYCodeDataRoot(base)).toBe(join(base, ".ycode"));
    seedLegacy();
    expect(resolveYCodeDataRoot(base)).toBe(join(base, ".zcode"));
    mkdirSync(join(base, ".ycode"));
    clearYCodeDataRootCache();
    expect(resolveYCodeDataRoot(base)).toBe(join(base, ".ycode"));
  });

  it("resolves beta independently", () => {
    seedLegacy(".zcode-beta");
    expect(resolveYCodeDataRoot(base, "beta")).toBe(join(base, ".zcode-beta"));
    expect(resolveYCodeDataRoot(base)).toBe(join(base, ".ycode"));
  });
});

describe("migrateLegacyDataDirSync", () => {
  it("renames the legacy dir and links the old path to the new one", () => {
    seedLegacy();
    const result = migrateLegacyDataDirSync(base, { allowRename: true });
    expect(result.outcome).toBe("migrated");
    expect(lstatSync(join(base, ".ycode")).isDirectory()).toBe(true);
    expect(lstatSync(join(base, ".zcode")).isSymbolicLink()).toBe(true);
    // 经旧路径写入的内容落在新目录：只有一份数据。
    writeFileSync(join(base, ".zcode", "v2", "via-link.txt"), "x");
    expect(readFileSync(join(base, ".ycode", "v2", "via-link.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(base, ".ycode", "v2", "setting.json"), "utf8")).toContain("zh-CN");
    expect(resolveYCodeDataRoot(base)).toBe(join(base, ".ycode"));
  });

  it("is idempotent once migrated", () => {
    seedLegacy();
    migrateLegacyDataDirSync(base, { allowRename: true });
    const again = migrateLegacyDataDirSync(base, { allowRename: true });
    expect(again.outcome).toBe("unchanged");
    expect(again.plan).toEqual({ action: "none", reason: "legacy-is-link" });
  });

  it("migrates the beta dir", () => {
    seedLegacy(".zcode-beta");
    const result = migrateLegacyDataDirSync(base, { allowRename: true, flavor: "beta" });
    expect(result.outcome).toBe("migrated");
    expect(lstatSync(join(base, ".zcode-beta")).isSymbolicLink()).toBe(true);
    expect(resolveYCodeDataRoot(base, "beta")).toBe(join(base, ".ycode-beta"));
  });

  it("does not rename when not allowed (dev/isolated runs)", () => {
    seedLegacy();
    const result = migrateLegacyDataDirSync(base, { allowRename: false });
    expect(result.outcome).toBe("skipped");
    expect(lstatSync(join(base, ".zcode")).isDirectory()).toBe(true);
    expect(() => lstatSync(join(base, ".ycode"))).toThrow();
  });

  it("is a no-op when both are real directories", () => {
    seedLegacy();
    mkdirSync(join(base, ".ycode"));
    const result = migrateLegacyDataDirSync(base, { allowRename: true });
    expect(result.outcome).toBe("skipped");
    expect(result.plan).toEqual({ action: "none", reason: "both-directories" });
    expect(lstatSync(join(base, ".zcode")).isDirectory()).toBe(true);
  });

  it("creates the new dir and the link on a fresh base", () => {
    const result = migrateLegacyDataDirSync(base, { allowRename: false });
    expect(result.outcome).toBe("created");
    expect(lstatSync(join(base, ".ycode")).isDirectory()).toBe(true);
    expect(lstatSync(join(base, ".zcode")).isSymbolicLink()).toBe(true);
  });

  it("re-creates a missing link next to an existing .ycode", () => {
    mkdirSync(join(base, ".ycode"));
    const result = migrateLegacyDataDirSync(base, { allowRename: false });
    expect(result.outcome).toBe("linked");
    expect(lstatSync(join(base, ".zcode")).isSymbolicLink()).toBe(true);
  });

  it("skips and keeps the legacy dir when rename fails (locked on Windows)", () => {
    seedLegacy();
    const lockedFs: DataDirMigrationFs = {
      ...nodeDataDirMigrationFs,
      rename: () => {
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      },
    };
    const result = migrateLegacyDataDirSync(base, { allowRename: true, fs: lockedFs });
    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("EBUSY");
    expect(lstatSync(join(base, ".zcode")).isDirectory()).toBe(true);
    expect(resolveYCodeDataRoot(base)).toBe(join(base, ".zcode"));
  });

  it("rolls back the rename when the link cannot be created", () => {
    seedLegacy();
    const noLinkFs: DataDirMigrationFs = {
      ...nodeDataDirMigrationFs,
      symlink: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    };
    const result = migrateLegacyDataDirSync(base, { allowRename: true, fs: noLinkFs });
    expect(result.outcome).toBe("rolled-back");
    expect(lstatSync(join(base, ".zcode")).isDirectory()).toBe(true);
    expect(readFileSync(join(base, ".zcode", "v2", "setting.json"), "utf8")).toContain("zh-CN");
    expect(() => lstatSync(join(base, ".ycode"))).toThrow();
  });

  it("uses an absolute junction target on Windows and a relative target elsewhere", () => {
    const calls: Array<[string, string, string]> = [];
    const recordingFs: DataDirMigrationFs = {
      lstat: () => null,
      rename: () => undefined,
      mkdir: () => undefined,
      symlink: (target, path, type) => {
        calls.push([target, path, type]);
      },
    };
    migrateLegacyDataDirSync(base, { allowRename: true, fs: recordingFs, platform: "win32" });
    migrateLegacyDataDirSync(base, { allowRename: true, fs: recordingFs, platform: "linux" });
    expect(calls).toEqual([
      [join(base, ".ycode"), join(base, ".zcode"), "junction"],
      [".ycode", join(base, ".zcode"), "dir"],
    ]);
  });
});
