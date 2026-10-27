"use client";

import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { Loader2Icon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";
import {
  completeMermaidSourceLines,
  createMermaidLiveRenderer,
  createMermaidRenderCoordinator,
  namespaceMermaidSvg,
} from "@/components/ai-elements/mermaid-rendering/index.js";
import type { MermaidLiveRenderer } from "@/components/ai-elements/mermaid-rendering/contract.js";

interface MermaidRenderState {
  svg: string | null;
  errorKey: string | null;
}

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  /**
   * 应用主题（store 耦合剥离）：由调用方从上层状态传入。
   * 默认 "system" 跟随操作系统，供旧调用点/待删代码兜底。
   */
  theme?: Theme;
  streaming?: boolean;
  renderEnabled?: boolean;
  fontSizePx?: number;
  onOpenPreview?: () => void;
  onPreviewSvgChange?: (svg: string | null) => void;
}

const mermaidPlugin = createMermaidPlugin();
const mermaidCoordinator = createMermaidRenderCoordinator(async (id, source, config) => {
  // 排队后页面可能已隐藏；在创建 Mermaid DOM 前再次检查，恢复后会用最新候选重试。
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    throw new Error("Mermaid rendering paused while document is hidden");
  }
  const renderer = mermaidPlugin.getMermaid(config);
  return (await renderer.render(id, source)).svg;
});
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid 底层的 khroma 解析器不支持 Tailwind v4 常见的 oklab/color-mix 结果。
// 先让浏览器解析主题 token，再通过 canvas 采样成传统 rgb/rgba，避免把现代 CSS 颜色直接传给 Mermaid。
// Web 远程控制的启动测试只提供了最小 document mock，SSR/预渲染环境也可能没有 DOM 工厂；
// 颜色归一化是增强能力，不能让 MessageResponse 的静态导入在这些环境中直接崩溃。
const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // 如果 canvas 也不支持该颜色格式，fillStyle 会停在哨兵色，直接回退到 Mermaid 可解析的安全色。
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const background = resolveCssColor(
    "--color-card",
    resolvedTheme === "dark" ? "#18181b" : "#ffffff",
  );
  const surface = resolveCssColor(
    "--color-surface",
    resolvedTheme === "dark" ? "#27272a" : "#f4f4f5",
  );
  const accent = resolveCssColor(
    "--color-accent",
    resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff",
  );
  const text = resolveCssColor(
    "--color-foreground",
    resolvedTheme === "dark" ? "#f4f4f5" : "#27272a",
  );
  const subtleText = resolveCssColor(
    "--color-foreground-subtle",
    resolvedTheme === "dark" ? "#a1a1aa" : "#52525b",
  );
  const border = resolveCssColor(
    "--color-border",
    resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8",
  );

  return {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

function resolveBrowserTheme(theme: Theme): "light" | "dark" {
  if (typeof window === "undefined") {
    return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  }

  return resolveTheme(theme);
}

function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setRevision((current) => current + 1);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  return revision;
}

export function MermaidBlock({
  code,
  className,
  theme = "system",
  streaming = false,
  renderEnabled = true,
  fontSizePx = 14,
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { intl } = useZCodeIntl();
  const systemThemeRevision = useSystemThemeRevision(theme);
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const source = streaming ? completeMermaidSourceLines(code) : code.trim();
  const resolvedTheme = resolveBrowserTheme(theme);
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`;
  const mermaidConfig = useMemo(
    () => ({ ...createMermaidConfig(resolvedTheme), fontSize: fontSizePx }),
    [fontSizePx, resolvedTheme, themeKey],
  );
  const request = useMemo(() => ({ source, config: mermaidConfig }), [source, mermaidConfig]);
  const renderKey = JSON.stringify(request);
  const cachedSvg = mermaidCoordinator.peek(request);
  const [renderState, setRenderState] = useState<MermaidRenderState>(() => ({
    svg: cachedSvg ?? null,
    errorKey: null,
  }));
  const liveRef = useRef<MermaidLiveRenderer | null>(null);
  const displayTemplate = cachedSvg ?? renderState.svg;
  const displaySvg = useMemo(
    () =>
      displayTemplate
        ? namespaceMermaidSvg(displayTemplate, `zcode-mermaid-${renderIdPrefix}`)
        : null,
    [displayTemplate, renderIdPrefix],
  );
  const hasFinalError = !streaming && renderState.errorKey === renderKey && cachedSvg === undefined;

  useEffect(() => {
    const live = createMermaidLiveRenderer(mermaidCoordinator, {
      onSuccess(svg) {
        setRenderState({ svg, errorKey: null });
      },
      onError(error, candidate) {
        logger.debug("[MermaidBlock] Mermaid 渲染失败", {
          // Mermaid 的错误 message 可能包含用户源码，只记录错误类型与规模。
          errorName: error instanceof Error ? error.name : "UnknownError",
          codeLength: candidate.source.length,
        });
        // 半截源码失败由 controller 静默保留旧图；最终失败才提供明确提示与源码入口。
        const key = JSON.stringify({ source: candidate.source, config: candidate.config });
        setRenderState((current) => ({ ...current, errorKey: key }));
      },
    });
    liveRef.current = live;
    return () => {
      live.dispose();
      liveRef.current = null;
    };
  }, []);

  useEffect(() => {
    liveRef.current?.setEnabled(renderEnabled);
    liveRef.current?.update({ ...request, complete: !streaming });
  }, [renderEnabled, request, streaming]);

  useEffect(() => {
    onPreviewSvgChange?.(displaySvg);
    return () => onPreviewSvgChange?.(null);
  }, [displaySvg, onPreviewSvgChange]);

  return (
    <div
      className={cn("group/mermaid relative min-h-32 w-full bg-card", className)}
      data-mermaid-block=""
      {...props}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-foreground">
        {!displaySvg && !hasFinalError ? (
          <div
            role="status"
            className="flex min-h-28 items-center justify-center gap-2 text-foreground-subtle text-ui-base"
          >
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "codeBlock.mermaid.loading" })}</span>
          </div>
        ) : null}
        {displaySvg ? (
          <div
            aria-label={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
            className="flex min-h-28 items-center justify-center [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: displaySvg }}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
        {hasFinalError ? (
          <div className="text-ui-sm text-foreground-subtle" role="alert">
            <p>{intl.formatMessage({ id: "codeBlock.mermaid.failed" })}</p>
            <details>
              <summary className="cursor-pointer py-1">
                {intl.formatMessage({ id: "codeBlock.mermaid.viewSource" })}
              </summary>
              <pre className="whitespace-pre-wrap break-words font-mono text-ui-base">{code}</pre>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}
