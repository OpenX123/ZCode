import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearYCodeDataRootCache } from "@zcode/shared/ycode-data-root";
import { logEarlyDataDirMigrationReport, runEarlyDataDirMigration } from "./bootstrap.js";
import { exampleAllowRename } from "./contract.example.js";
import { collectMigrationBaseDirs, shouldAllowDataDirRename } from "./contract.js";

// 只使用 mkdtemp 临时目录作为 home，不触碰真实用户数据目录。
const tempDirs: string[] = [];
function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ycode-desktop-migration-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearYCodeDataRootCache();
});

describe("desktop data dir migration contract", () => {
  it("allows rename only for packaged, non-isolated runs or explicit dev opt-in", () => {
    expect(exampleAllowRename()).toEqual([true, false]);
    expect(shouldAllowDataDirRename({ env: {}, isPackaged: false })).toBe(false);
    expect(
      shouldAllowDataDirRename({ env: { YCODE_DATA_DIR_MIGRATION: "1" }, isPackaged: false }),
    ).toBe(true);
    expect(shouldAllowDataDirRename({ env: { ZCODE_E2E_RUN_ID: "r1" }, isPackaged: true })).toBe(
      false,
    );
    expect(
      shouldAllowDataDirRename({ env: { ZCODE_DESKTOP_HOME_DIR: "/tmp/h" }, isPackaged: true }),
    ).toBe(false);
  });

  it("dedupes base dirs case-insensitively on Windows", () => {
    expect(
      collectMigrationBaseDirs(["C:\\Users\\a", "c:/users/a/", undefined, ""], "win32"),
    ).toEqual(["C:\\Users\\a"]);
    expect(collectMigrationBaseDirs(["/home/a", "/home/a/", "/data"], "linux")).toEqual([
      "/home/a",
      "/data",
    ]);
  });

  it("migrates home first, then the dataBaseDir read from the migrated setting.json", () => {
    const home = makeTempHome();
    const dataBase = makeTempHome();
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "v2", "setting.json"),
      JSON.stringify({ dataBaseDir: dataBase }),
    );
    mkdirSync(join(dataBase, ".zcode", "v2"), { recursive: true });
    const env: Record<string, string | undefined> = { YCODE_STORAGE_DIR: "/y" };

    const report = runEarlyDataDirMigration({ env, isPackaged: true, homeDir: home });

    expect(report.allowRename).toBe(true);
    expect(report.appliedEnvAliases).toEqual(["STORAGE_DIR"]);
    expect(env.ZCODE_STORAGE_DIR).toBe("/y");
    expect(report.results.map((r) => [r.baseDir, r.flavor, r.outcome])).toEqual([
      [home, "stable", "migrated"],
      [dataBase, "stable", "migrated"],
    ]);
    expect(lstatSync(join(home, ".zcode")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dataBase, ".zcode")).isSymbolicLink()).toBe(true);
    // 未使用 Beta 的用户不创建 .ycode-beta。
    expect(() => lstatSync(join(home, ".ycode-beta"))).toThrow();
  });

  it("keeps the legacy dir in dev runs and logs it as info", () => {
    const home = makeTempHome();
    mkdirSync(join(home, ".zcode"), { recursive: true });
    const report = runEarlyDataDirMigration({ env: {}, isPackaged: false, homeDir: home });
    expect(report.results[0]?.outcome).toBe("skipped");
    expect(lstatSync(join(home, ".zcode")).isDirectory()).toBe(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logEarlyDataDirMigrationReport(report, logger);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
