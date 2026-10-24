import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfigMap,
  ProviderRegistryService,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

class MutableSource<TSnapshot> implements ProviderSource<TSnapshot> {
  current: TSnapshot;
  nextRead: (() => Promise<TSnapshot>) | null = null;
  readonly read = vi.fn(async (): Promise<TSnapshot> => {
    const nextRead = this.nextRead;
    this.nextRead = null;
    return nextRead ? nextRead() : this.current;
  });
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(initial: TSnapshot) {
    this.current = initial;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

function modelConfig(contextWindow = 200_000): ModelConfig {
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
    enabled: true,
  });
}

function configSnapshot(revision: string, modelId: string): ProviderConfigSnapshot {
  return {
    revision,
    zcodeBuiltinRevision: revision,
    personalRevision: "personal-1",
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "local",
        createApiKeyProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://api.example.com",
          apiKey: "test-key",
          models: [modelId],
        }),
      ],
    ]),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      { type: "model", modelMatch: modelId, config: modelConfig() },
    ]),
    personalModels: ModelConfigRules.empty(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ProviderRegistryService", () => {
  it("start 只返回就绪；Config 更新后显式读取当前快照，不重复启动刷新", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const service = new ProviderRegistryService({ configSource });
    try {
      expect(await service.start()).toBeUndefined();
      configSource.current = configSnapshot("config-2", "model-b");
      await service.refresh("config-change");
      const reads = configSource.read.mock.calls.length;
      expect(await service.start()).toBeUndefined();
      expect(service.getSnapshot()?.sourceRevisions.config).toBe("config-2");
      expect(configSource.read).toHaveBeenCalledTimes(reads);
    } finally {
      service.dispose();
    }
  });

  it("通过唯一 Config Source 初始化并发布完整快照", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const service = new ProviderRegistryService({ configSource });
    const listener = vi.fn();
    service.onDidChange(listener);

    await service.start();
    const snapshot = service.getSnapshot()!;

    expect(snapshot.sourceRevisions).toEqual({ config: "config-1" });
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].reasons).toEqual(["start"]);
  });

  it("读取期间发生新失效时丢弃过时代际，只发布最新 Source", async () => {
    const configV1 = configSnapshot("config-1", "model-a");
    const configV2 = configSnapshot("config-2", "model-b");
    const firstRead = deferred<ProviderConfigSnapshot>();
    const configSource = new MutableSource(configV1);
    configSource.nextRead = () => firstRead.promise;
    const service = new ProviderRegistryService({ configSource });
    const listener = vi.fn();
    service.onDidChange(listener);

    const start = service.start();
    await vi.waitFor(() => expect(configSource.read).toHaveBeenCalledTimes(1));
    configSource.current = configV2;
    configSource.emit("config-file-changed");
    firstRead.resolve(configV1);
    await start;

    expect(configSource.read).toHaveBeenCalledTimes(2);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].reasons).toEqual(
      expect.arrayContaining(["start", "config:config-file-changed"]),
    );
  });

  it("Source revision 未变化时不重复发布 Registry", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const service = new ProviderRegistryService({ configSource });
    const listener = vi.fn();
    service.onDidChange(listener);
    await service.start();
    const initial = service.getSnapshot()!;

    const duplicate = await service.refresh("explicit-refresh");

    expect(duplicate).toBe(initial);
    expect(service.getView().revision).toBe(initial.registry.revision);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("发布回调中请求的新刷新不会被即将结束的旧刷新吞掉", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const service = new ProviderRegistryService({ configSource });
    let followUp: Promise<unknown> | null = null;
    service.onDidChange(() => {
      if (followUp) return;
      configSource.current = configSnapshot("config-2", "model-b");
      followUp = service.refresh("listener-refresh");
    });

    await service.start();
    await followUp;

    expect(service.getSnapshot()?.sourceRevisions.config).toBe("config-2");
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
  });

  it("刷新失败保留上一份成功 View，并允许后续刷新恢复", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const service = new ProviderRegistryService({ configSource });
    const errorListener = vi.fn();
    service.onDidRefreshError(errorListener);
    await service.start();
    const initial = service.getSnapshot()!;

    configSource.nextRead = async () => {
      throw new Error("config unavailable");
    };
    await expect(service.refresh("broken-config")).rejects.toThrow("config unavailable");

    expect(service.getSnapshot()).toBe(initial);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(errorListener).toHaveBeenCalledTimes(1);

    configSource.current = configSnapshot("config-2", "model-b");
    const recovered = await service.refresh("config-recovered");
    expect(recovered.sourceRevisions.config).toBe("config-2");
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
  });

  it("Personal-only revision 变化直接发布当前配置", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const service = new ProviderRegistryService({ configSource });
    await service.start();

    configSource.current = {
      ...configSnapshot("combined-2", "model-a"),
      zcodeBuiltinRevision: "config-1",
      personalRevision: "personal-2",
    };
    const next = await service.refresh("personal-updated");

    expect(next.config.personalRevision).toBe("personal-2");
    expect(next).not.toHaveProperty("account");
  });
});
