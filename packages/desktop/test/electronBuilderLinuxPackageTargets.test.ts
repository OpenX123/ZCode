import { describe, expect, it } from "vitest";
import desktopBuilderConfig from "../electron-builder.config.js";
import { resolveDesktopProductIdentity } from "../scripts/desktop-product-identity.mjs";

// Linux 安装格式继续保留；独立桌面已退役原厂自动更新，不再约束旧更新元数据。
describe("electron-builder Linux 打包目标", () => {
  it("不配置已退役的自动更新发布端点与频道", () => {
    expect(desktopBuilderConfig).not.toHaveProperty("publish");
    expect(desktopBuilderConfig).not.toHaveProperty("detectUpdateChannel");
  });

  it("Linux 同时产出 AppImage、deb、rpm 与 pacman 安装包", () => {
    const targets = desktopBuilderConfig.linux?.target ?? [];

    expect(targets).toContain("AppImage");
    expect(targets).toContain("deb");
    expect(targets).toContain("rpm");
    expect(targets).toContain("pacman");
  });

  it("rpm 与 deb 的 packageName 按 flavor 拆分且保持一致", () => {
    // 生产版与 Preview 必须是两个独立系统包：rpm 若复用默认包名，
    // dnf 会把另一 flavor 的安装当成升级替换，与 deb 的 packageName 约束对齐。
    const identity = resolveDesktopProductIdentity();

    expect(desktopBuilderConfig.rpm?.packageName).toBe(identity.linuxPackageName);
    expect(desktopBuilderConfig.deb?.packageName).toBe(identity.linuxPackageName);
    expect(desktopBuilderConfig.pacman?.packageName).toBe(identity.linuxPackageName);
  });

  it("rpm 通过 fpm 追加 Electron 实际需要的运行库 Requires", () => {
    // electron-builder 的 rpm 默认 Requires 不含 mesa-libgbm / alsa-lib（Electron ELF 的
    // DT_NEEDED 实际依赖），最小化 RHEL 上装完会启动失败；必须以 fpm -d 追加而不是
    // depends 整组替换默认 Requires。
    expect(desktopBuilderConfig.rpm?.fpm).toContain("mesa-libgbm");
    expect(desktopBuilderConfig.rpm?.fpm).toContain("alsa-lib");
    expect(desktopBuilderConfig.rpm?.fpm).toContain("-d");
  });

  it("pacman 使用 Arch 原生 .pkg.tar.zst 扩展名", () => {
    expect(desktopBuilderConfig.pacman?.artifactName).toContain(".pkg.tar.zst");
  });

  it("pacman 显式声明 Electron 启动所需的 Arch 运行库", () => {
    const dependencies = desktopBuilderConfig.pacman?.depends ?? [];

    // 显式依赖必须使用 Arch 官方仓库中的包名，避免 electron-builder 时代久远的
    // 默认集合引入已移除的 libappindicator-gtk3/http-parser 等包导致 pacman -U 失败。
    expect(dependencies).toEqual([
      "gtk3",
      "nss",
      "libxss",
      "libxtst",
      "libnotify",
      "alsa-lib",
      "mesa",
      "xdg-utils",
    ]);
  });

  it("pacman 不显式覆盖 electron-builder 的默认压缩格式", () => {
    // electron-builder 26.8.1 的 pacman 默认产物就是 zstd；显式填写 zstd 会被其
    // 配置 schema 拒绝，因此只约束扩展名，不在配置中覆盖默认压缩格式。
    expect(desktopBuilderConfig.pacman?.compression).toBeUndefined();
  });
});
