import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** 仅为 /m/ 构建补充安装资源；摘要路径复用中继现有 immutable 资源策略。 */
export function mobileAppPlugin() {
  let enabled = false;
  let tags = [];
  return {
    name: "zcode:mobile-app",
    apply: "build",
    configResolved(config) {
      enabled = config.base === "/m/";
    },
    async buildStart() {
      if (!enabled) return;
      const emit = (name, extension, source) => {
        const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
        const fileName = `${name}-${hash}.${extension}`;
        this.emitFile({ type: "asset", fileName, source });
        return `/m/${fileName}`;
      };
      const icons = [];
      let appleIcon;
      for (const size of [192, 512, 180]) {
        const source = await readFile(
          new URL(`../src/mobile/assets/icon-${size}.png`, import.meta.url),
        );
        const src = emit(`icon-${size}`, "png", source);
        if (size === 180) appleIcon = src;
        else
          icons.push({ src, sizes: `${size}x${size}`, type: "image/png", purpose: "any maskable" });
      }
      const manifest = emit(
        "manifest",
        "webmanifest",
        JSON.stringify({
          id: "/m/",
          name: "YCode",
          short_name: "YCode",
          start_url: "/m/",
          scope: "/m/",
          display: "standalone",
          background_color: "#161616",
          theme_color: "#161616",
          icons,
        }),
      );
      const worker = emit(
        "mobile-sw",
        "js",
        await readFile(new URL("../src/mobile/service-worker.js", import.meta.url)),
      );
      tags = [
        { tag: "link", attrs: { rel: "manifest", href: manifest } },
        { tag: "link", attrs: { rel: "apple-touch-icon", sizes: "180x180", href: appleIcon } },
        { tag: "meta", attrs: { name: "apple-mobile-web-app-capable", content: "yes" } },
        { tag: "meta", attrs: { name: "mobile-web-app-capable", content: "yes" } },
        { tag: "meta", attrs: { name: "apple-mobile-web-app-title", content: "YCode" } },
        {
          tag: "meta",
          attrs: { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
        },
        {
          tag: "script",
          attrs: { type: "module" },
          children: `if ('serviceWorker' in navigator) {
            try { await navigator.serviceWorker.register(${JSON.stringify(worker)}, { scope: '/m/', updateViaCache: 'none' }); }
            catch { /* 安装增强可能被浏览器策略禁用，不阻断在线配对。 */ }
          }`,
        },
      ];
    },
    transformIndexHtml(html) {
      if (!enabled) return html;
      return {
        html: html.replace(
          'content="width=device-width, initial-scale=1.0"',
          'content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-visual"',
        ),
        tags,
      };
    },
  };
}
