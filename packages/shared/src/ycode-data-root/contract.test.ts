import { describe, expect, it } from "vitest";
import { describeDataRoot } from "./contract.example.js";
import {
  applyYCodeEnvAliases,
  chooseDataRootDirName,
  planDataDirMigration,
  readYCodeEnv,
} from "./contract.js";

describe("ycode data root contract", () => {
  it("prefers .ycode, falls back to an unmigrated .zcode, defaults to .ycode", () => {
    expect(chooseDataRootDirName({ nextExists: true, legacyExists: true })).toBe(".ycode");
    expect(chooseDataRootDirName({ nextExists: false, legacyExists: true })).toBe(".zcode");
    expect(chooseDataRootDirName({ nextExists: false, legacyExists: false })).toBe(".ycode");
    expect(chooseDataRootDirName({ nextExists: false, legacyExists: true }, "beta")).toBe(
      ".zcode-beta",
    );
    expect(chooseDataRootDirName({ nextExists: false, legacyExists: false }, "beta")).toBe(
      ".ycode-beta",
    );
  });

  it("plans migration from the lstat projection", () => {
    expect(
      planDataDirMigration({ legacy: "directory", next: "missing", allowRename: true }),
    ).toEqual({ action: "rename-and-link" });
    expect(
      planDataDirMigration({ legacy: "directory", next: "missing", allowRename: false }),
    ).toEqual({ action: "none", reason: "rename-not-allowed" });
    expect(
      planDataDirMigration({ legacy: "missing", next: "missing", allowRename: false }),
    ).toEqual({ action: "create-and-link" });
    expect(
      planDataDirMigration({ legacy: "missing", next: "directory", allowRename: false }),
    ).toEqual({ action: "link-only" });
    expect(planDataDirMigration({ legacy: "link", next: "directory", allowRename: true })).toEqual({
      action: "none",
      reason: "legacy-is-link",
    });
    expect(
      planDataDirMigration({ legacy: "directory", next: "directory", allowRename: true }),
    ).toEqual({ action: "none", reason: "both-directories" });
    // 新位置是链接（远端反向链接）时不能再补旧位置链接，否则成环。
    expect(planDataDirMigration({ legacy: "missing", next: "link", allowRename: true })).toEqual({
      action: "none",
      reason: "unexpected-entry",
    });
    expect(planDataDirMigration({ legacy: "other", next: "missing", allowRename: true })).toEqual({
      action: "none",
      reason: "unexpected-entry",
    });
  });

  it("reads YCODE_ before ZCODE_ and ignores blank values", () => {
    expect(
      readYCodeEnv({ YCODE_DATA_BASE_DIR: "/y", ZCODE_DATA_BASE_DIR: "/z" }, "DATA_BASE_DIR"),
    ).toBe("/y");
    expect(
      readYCodeEnv({ YCODE_DATA_BASE_DIR: " ", ZCODE_DATA_BASE_DIR: "/z" }, "DATA_BASE_DIR"),
    ).toBe("/z");
    expect(readYCodeEnv({}, "DATA_BASE_DIR")).toBeUndefined();
    expect(describeDataRoot({ ZCODE_DATA_BASE_DIR: "/z" })).toBe("/z/.zcode");
  });

  it("propagates YCODE_ names to ZCODE_ names except ENV", () => {
    const env: Record<string, string | undefined> = {
      YCODE_STORAGE_DIR: "/y/storage",
      ZCODE_STORAGE_DIR: "/z/storage",
      ZCODE_DATA_BASE_DIR: "/z",
      YCODE_ENV: "beta",
      ZCODE_ENV: "production",
    };
    expect(applyYCodeEnvAliases(env)).toEqual(["STORAGE_DIR"]);
    expect(env.ZCODE_STORAGE_DIR).toBe("/y/storage");
    expect(env.ZCODE_DATA_BASE_DIR).toBe("/z");
    expect(env.ZCODE_ENV).toBe("production");
  });
});
