import type { MermaidConfig } from "@streamdown/mermaid";
import type {
  MermaidLiveCallbacks,
  MermaidLiveCandidate,
  MermaidLiveRenderer,
  MermaidRenderCoordinator,
  MermaidRenderOptions,
  MermaidRenderRequest,
} from "./contract.js";

export type { MermaidRenderRequest } from "./contract.js";

const STREAMING_INTERVAL_MS = 160;
let nextRenderId = 0;

function requestKey(request: MermaidRenderRequest): string {
  // 不使用短 hash 作相等判断，避免碰撞让另一个会话拿到错误图表。
  return JSON.stringify([1, request.source.trim(), request.config]);
}

export function createMermaidRenderCoordinator(
  render: (id: string, source: string, config: MermaidConfig) => Promise<string>,
  { maxEntries = 96, maxBytes = 16 * 1024 * 1024 }: MermaidRenderOptions = {},
): MermaidRenderCoordinator {
  const cache = new Map<string, { svg: string; bytes: number }>();
  const inflight = new Map<string, Promise<string>>();
  let bytes = 0;
  let queue = Promise.resolve();

  const peek = (request: MermaidRenderRequest): string | undefined => {
    const key = requestKey(request);
    const hit = cache.get(key);
    if (!hit) return undefined;
    cache.delete(key);
    cache.set(key, hit);
    return hit.svg;
  };

  return {
    peek,
    render(request) {
      const key = requestKey(request);
      const hit = peek(request);
      if (hit !== undefined) return Promise.resolve(hit);
      const existing = inflight.get(key);
      if (existing) return existing;
      const run = queue
        .then(() =>
          render(`zcode-mermaid-template-${++nextRenderId}`, request.source.trim(), request.config),
        )
        .then((svg) => {
          const entryBytes = (key.length + svg.length) * 2;
          if (entryBytes <= maxBytes && maxEntries > 0) {
            cache.set(key, { svg, bytes: entryBytes });
            bytes += entryBytes;
            while (cache.size > maxEntries || bytes > maxBytes) {
              const oldest = cache.entries().next().value;
              if (!oldest) break;
              bytes -= oldest[1].bytes;
              cache.delete(oldest[0]);
            }
          }
          return svg;
        })
        .finally(() => inflight.delete(key));
      // Mermaid 使用全局配置，成功和失败都必须释放同一条串行队列。
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      inflight.set(key, run);
      return run;
    },
  };
}

export function createMermaidLiveRenderer(
  coordinator: MermaidRenderCoordinator,
  callbacks: MermaidLiveCallbacks,
): MermaidLiveRenderer {
  let latest: MermaidLiveCandidate | undefined;
  let version = 0;
  let running = false;
  let enabled = true;
  let disposed = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = () => {
    timer = undefined;
    if (disposed || !enabled || running || !pending || !latest) return;
    const candidate = latest;
    const admittedVersion = version;
    pending = false;
    if (!candidate.source.trim()) {
      if (candidate.complete) callbacks.onError(new Error("Empty Mermaid source"), candidate);
      return;
    }
    running = true;
    void coordinator
      .render(candidate)
      .then(
        (svg) => {
          if (!disposed && enabled && version === admittedVersion)
            callbacks.onSuccess(svg, candidate);
        },
        (error: unknown) => {
          if (!disposed && enabled && version === admittedVersion && candidate.complete) {
            callbacks.onError(error, candidate);
          }
        },
      )
      .finally(() => {
        running = false;
        schedule();
      });
  };
  const schedule = () => {
    if (disposed || !enabled || running || !pending) return;
    if (timer !== undefined) {
      if (!latest?.complete) return;
      clearTimeout(timer);
      timer = undefined;
    }
    // 闭合围栏立即排队；流式更新合并只是性能预算，版本号才负责时序正确性。
    if (latest?.complete) queueMicrotask(drain);
    else timer = setTimeout(drain, STREAMING_INTERVAL_MS);
  };

  return {
    update(candidate) {
      if (disposed) return;
      if (
        latest &&
        requestKey(latest) === requestKey(candidate) &&
        latest.complete === candidate.complete
      )
        return;
      latest = candidate;
      version += 1;
      pending = true;
      schedule();
    },
    setEnabled(next) {
      if (enabled === next || disposed) return;
      enabled = next;
      if (!enabled && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // 隐藏期间丢弃的提交需要在恢复后重新从成功缓存取回。
      if (enabled && latest) pending = true;
      schedule();
    },
    dispose() {
      disposed = true;
      latest = undefined;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** 仅扫描模型真实输出的围栏，不能把 Streamdown 补全的 fence 当作块完成。 */
export function collectClosedMarkdownFences(markdown: string): ReadonlySet<string> {
  const closed = new Set<string>();
  let opening: { marker: string; length: number; lines: string[] } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opening) {
      if (fence) opening = { marker: fence[1]![0]!, length: fence[1]!.length, lines: [] };
    } else if (
      fence &&
      fence[1]![0] === opening.marker &&
      fence[1]!.length >= opening.length &&
      !fence[2]!.trim()
    ) {
      closed.add(opening.lines.join("\n").trim());
      opening = undefined;
    } else opening.lines.push(line);
  }
  return closed;
}

/** 流式候选只包含完整行，尾部半截语句等下一次增量再尝试。 */
export function completeMermaidSourceLines(source: string): string {
  const lastNewline = source.lastIndexOf("\n");
  return lastNewline < 0 ? "" : source.slice(0, lastNewline).trim();
}

export function namespaceMermaidSvg(svg: string, namespace: string): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return svg;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return svg;
  const ids = new Map<string, string>();
  for (const element of doc.querySelectorAll("[id]")) {
    const id = element.getAttribute("id")!;
    ids.set(id, `${namespace}-${id}`);
  }
  const replaceUrls = (value: string) =>
    value.replace(/url\(\s*(["']?)#([^\s)'"#]+)\1\s*\)/g, (match, _quote: string, id: string) =>
      ids.has(id) ? `url(#${ids.get(id)})` : match,
    );
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      let value = attribute.value;
      if (attribute.name === "id") value = ids.get(value) ?? value;
      else if (attribute.localName === "href" && value.startsWith("#"))
        value = `#${ids.get(value.slice(1)) ?? value.slice(1)}`;
      else if (attribute.name === "aria-labelledby" || attribute.name === "aria-describedby") {
        value = value
          .split(/\s+/)
          .map((id) => ids.get(id) ?? id)
          .join(" ");
      } else value = replaceUrls(value);
      attribute.value = value;
    }
    if (element.localName === "style" && element.textContent) {
      // 只改 CSS 规则的 selector 区域；声明中的 #abc 等颜色值不能被当作 ID。
      element.textContent = replaceUrls(element.textContent).replace(
        /([^{}]+)\{/g,
        (_rule, selector: string) =>
          `${selector.replace(/#([\w-]+)/g, (match, id: string) => (ids.has(id) ? `#${ids.get(id)}` : match))}{`,
      );
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
