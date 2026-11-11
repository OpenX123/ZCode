import { describe, expect, it } from "vitest";
import { mobileAppPlugin } from "../vite/mobileAppPlugin.mjs";

describe("手机安装构建", () => {
  it("普通 Web 构建不注入安装入口或生成手机资源", async () => {
    const plugin = mobileAppPlugin();
    const assets: unknown[] = [];
    plugin.configResolved({ base: "/" });
    await plugin.buildStart.call({ emitFile: (asset: unknown) => assets.push(asset) });
    expect(plugin.transformIndexHtml("<html></html>")).toBe("<html></html>");
    expect(assets).toEqual([]);
  });

  it("手机清单保持稳定身份，所有资源路径带摘要且不携带配对信息", async () => {
    const plugin = mobileAppPlugin();
    const assets: { fileName: string; source: string | Buffer }[] = [];
    plugin.configResolved({ base: "/m/" });
    await plugin.buildStart.call({
      emitFile: (asset: { fileName: string; source: string | Buffer }) => assets.push(asset),
    });
    expect(assets).toHaveLength(5);
    for (const asset of assets) expect(asset.fileName).toMatch(/-[a-f0-9]{12}\./);
    const manifestAsset = assets.find((asset) => asset.fileName.endsWith(".webmanifest"))!;
    const manifest = JSON.parse(String(manifestAsset.source));
    expect(manifest).toMatchObject({
      id: "/m/",
      start_url: "/m/",
      scope: "/m/",
      display: "standalone",
    });
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
    for (const size of [180, 192, 512]) {
      const icon = assets.find((asset) => asset.fileName.startsWith(`icon-${size}-`))!;
      const png = Buffer.from(icon.source);
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    const output = plugin.transformIndexHtml(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    );
    expect(output.html).toContain("viewport-fit=cover");
    expect(output.html).not.toMatch(/maximum-scale|user-scalable/);
    expect(output.tags).toContainEqual({
      tag: "link",
      attrs: { rel: "manifest", href: `/m/${manifestAsset.fileName}` },
    });
    const worker = assets.find((asset) => asset.fileName.startsWith("mobile-sw-"))!;
    expect(String(worker.source)).not.toContain("caches.");
    expect(String(worker.source)).toContain('event.request.mode !== "navigate"');
  });
});
