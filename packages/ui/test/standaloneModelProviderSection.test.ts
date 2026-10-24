// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";

const state = vi.hoisted(() => ({
  saveProvider: vi.fn(),
  testModelConnectivity: vi.fn(),
  createPersonalProvider: vi.fn(async () => ({ providerId: "new-provider" })),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => {
    throw new Error("模型设置不应读取官方账号或套餐服务");
  },
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({}) }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));
vi.mock("@/hooks/useModelProviders.js", () => ({
  useModelProviders: () => ({
    ...state,
    modelProviders: [
      {
        providerId: "glm-api",
        providerName: "GLM API",
        config: { access: { type: "api-key" } },
        models: [],
        hasPersonalConfig: true,
      },
    ],
    providerTemplates: [],
    loading: false,
    refreshing: false,
    providerSettingsView: { revision: 1 },
    reorderableProviderIds: new Set(["glm-api"]),
  }),
}));
vi.mock("@/settings/model-provider-section/SectionLayout.js", () => ({
  ModelProviderSectionLayout: ({
    children,
    onAddProvider,
  }: {
    children: ReactNode;
    onAddProvider: () => void;
  }) =>
    createElement(
      "div",
      null,
      createElement("button", { onClick: onAddProvider }, "添加供应商"),
      children,
    ),
}));
vi.mock("@/settings/model-provider-section/InlineEditableProviderCard.js", () => ({
  InlineEditableProviderCard: ({
    provider,
    onSave,
    onTestModel,
  }: {
    provider: { providerId: string };
    onSave: (provider: unknown) => unknown;
    onTestModel: (id: string, model: string) => unknown;
  }) =>
    createElement(
      "div",
      null,
      createElement("span", null, provider.providerId),
      createElement("button", { onClick: () => onSave(provider) }, "保存"),
      createElement(
        "button",
        { onClick: () => onTestModel(provider.providerId, "glm-5") },
        "测试连接",
      ),
    ),
}));
vi.mock("@/settings/model-provider-section/ProviderTemplatePicker.js", () => ({
  ProviderTemplatePicker: ({
    onCreateFromTemplate,
  }: {
    onCreateFromTemplate: (id: string) => unknown;
  }) =>
    createElement(
      "button",
      { onClick: () => onCreateFromTemplate("bigmodel-standard-api") },
      "GLM 模板",
    ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("独立模型设置", () => {
  it("无需官方服务即可编辑普通 GLM Provider 并测试模型", () => {
    render(createElement(ModelProviderSection));
    expect(screen.getByText("glm-api")).toBeTruthy();
    fireEvent.click(screen.getByText("保存"));
    fireEvent.click(screen.getByText("测试连接"));
    expect(state.saveProvider).toHaveBeenCalled();
    expect(state.testModelConnectivity).toHaveBeenCalledWith("glm-api", "glm-5");
  });
  it("复用模板创建普通供应商", () => {
    render(createElement(ModelProviderSection));
    fireEvent.click(screen.getByText("添加供应商"));
    fireEvent.click(screen.getByText("GLM 模板"));
    expect(state.createPersonalProvider).toHaveBeenCalledWith({
      templateId: "bigmodel-standard-api",
      locale: "zh-CN",
    });
  });
});
