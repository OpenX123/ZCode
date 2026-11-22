import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFinderOpenFolderWorkflow } from "../src/main/desktopFinderOpenFolderWorkflow.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktopFinderOpenFolderWorkflow", () => {
  it("按中文 locale 写入 Finder 服务展示名", () => {
    const homeDir = createTempHome();
    const refreshServicesIndex = vi.fn();

    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "zh-CN",
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });

    const infoPlist = readInfoPlist(homeDir);
    expect(infoPlist).toContain("<string>在YCode中打开</string>");
    expect(infoPlist).not.toContain("<string>Open in YCode</string>");
    expect(refreshServicesIndex).toHaveBeenCalledTimes(1);
  });

  it("按英文 locale 写入 Finder 服务展示名并复用稳定 workflow 文件名", () => {
    const homeDir = createTempHome();
    const refreshServicesIndex = vi.fn();

    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "en-US",
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });

    const infoPlist = readInfoPlist(homeDir);
    expect(infoPlist).toContain("<string>Open in YCode</string>");
    expect(infoPlist).not.toContain("<string>在YCode中打开</string>");
    expect(infoPlist).toContain("<string>6</string>");
    expect(refreshServicesIndex).toHaveBeenCalledTimes(1);
  });

  it("workflow 使用 ycode:// 打开工作区", () => {
    const homeDir = createTempHome();
    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "en-US",
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex: vi.fn(),
    });

    const workflow = readFileSync(
      join(homeDir, "Library", "Services", "Open in YCode.workflow", "Contents", "document.wflow"),
      "utf8",
    );
    expect(workflow).toContain("ycode://workspace/open?path=");
    expect(workflow).not.toContain("zcode://");
  });

  it("清理本应用写入的旧 Open in ZCode.workflow，保留用户自建的同名服务", () => {
    const ownedHome = createTempHome();
    const ownedLegacyDir = writeLegacyWorkflow(ownedHome, "dev.zcode.app.finder-open-workflow");
    const refreshServicesIndex = vi.fn();
    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "en-US",
      homeDir: ownedHome,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });
    expect(existsSync(ownedLegacyDir)).toBe(false);
    expect(refreshServicesIndex).toHaveBeenCalledTimes(1);

    const customHome = createTempHome();
    const customLegacyDir = writeLegacyWorkflow(customHome, "com.example.user-workflow");
    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "en-US",
      homeDir: customHome,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex: vi.fn(),
    });
    expect(existsSync(customLegacyDir)).toBe(true);
  });

  it("非 macOS 不安装 Finder 服务", () => {
    const homeDir = createTempHome();
    const refreshServicesIndex = vi.fn();

    installFinderOpenFolderWorkflow({
      platform: "linux",
      locale: "zh-CN",
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });

    expect(refreshServicesIndex).not.toHaveBeenCalled();
  });
});

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-finder-workflow-"));
  tempDirs.push(dir);
  return dir;
}

function writeLegacyWorkflow(homeDir: string, bundleId: string): string {
  const legacyDir = join(homeDir, "Library", "Services", "Open in ZCode.workflow");
  mkdirSync(join(legacyDir, "Contents"), { recursive: true });
  writeFileSync(
    join(legacyDir, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
    "utf8",
  );
  return legacyDir;
}

function readInfoPlist(homeDir: string): string {
  return readFileSync(
    join(homeDir, "Library", "Services", "Open in YCode.workflow", "Contents", "Info.plist"),
    "utf8",
  );
}
