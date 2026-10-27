import type { MermaidConfig } from "@streamdown/mermaid";

export interface MermaidRenderRequest {
  source: string;
  config: MermaidConfig;
}

export interface MermaidRenderCoordinator {
  /** 同源码与实际配置精确匹配；同步命中并刷新 LRU，不触发 IO。 */
  peek(request: MermaidRenderRequest): string | undefined;
  /** 同键进行中请求复用，所有实际渲染串行；仅缓存成功结果，不持久化。 */
  render(request: MermaidRenderRequest): Promise<string>;
}

export interface MermaidLiveCandidate extends MermaidRenderRequest {
  complete: boolean;
}

export interface MermaidLiveRenderer {
  /** 替换最新候选；同一块最多一个执行中与一个待执行版本，旧结果不回调。 */
  update(candidate: MermaidLiveCandidate): void;
  /** 隐藏暂停新工作，恢复时继续最新版本，不取消其他实例的共享请求。 */
  setEnabled(enabled: boolean): void;
  /** 释放定时与回调；已经开始的全局请求仍可供其他实例复用。 */
  dispose(): void;
}

export interface MermaidLiveCallbacks {
  onSuccess(svg: string, candidate: MermaidLiveCandidate): void;
  onError(error: unknown, candidate: MermaidLiveCandidate): void;
}

export interface MermaidRenderOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export interface MermaidRenderingContract {
  coordinator: MermaidRenderCoordinator;
}
