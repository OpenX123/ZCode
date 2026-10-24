import { useCallback, useEffect, useMemo, useState } from "react";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { InlineEditableProviderCard } from "./model-provider-section/InlineEditableProviderCard.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import type { ModelProviderNavItem } from "./model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const [initialTarget] = useState(consumePendingSettingsModelProviderTarget);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => initialTarget?.providerId ?? null,
  );
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const providers = useMemo(
    () => sortModelProvidersForDisplay(modelProviders, displayOrder),
    [modelProviders, displayOrder],
  );
  const navigationItems = useMemo<ModelProviderNavItem[]>(
    () =>
      providers.map((provider) => ({
        key: createCustomProviderNodeKey(provider.providerId),
        type: "custom",
        label: getProviderFormLabel(provider),
        provider,
        statusActive: provider.executable,
      })),
    [providers],
  );
  // 这里只选择展示对象，不写模型选择。新建返回后等待 Registry 快照出现再校正导航。
  const selectedProvider =
    providers.find((provider) => provider.providerId === selectedProviderId) ??
    providers[0] ??
    null;
  useEffect(() => {
    if (
      pendingCreatedProviderId &&
      providers.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      setSelectedProviderId(pendingCreatedProviderId);
      setPendingCreatedProviderId(null);
    }
  }, [pendingCreatedProviderId, providers]);
  useEffect(() => {
    if (!pendingModelProviderTarget) return;
    setSelectedProviderId(pendingModelProviderTarget.providerId);
    setTemplatePickerOpen(false);
    onConsumePendingModelProviderTarget?.();
  }, [pendingModelProviderTarget, onConsumePendingModelProviderTarget]);
  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider" || !detail?.modelProviderId) return;
        setSelectedProviderId(detail.modelProviderId);
        setTemplatePickerOpen(false);
      }),
    [],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setSelectedProviderId(created.providerId);
        setPendingCreatedProviderId(created.providerId);
        setTemplatePickerOpen(false);
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  if (loadError) {
    return (
      <div role="alert" className="space-y-3 text-ui-base">
        <p>{intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}</p>
        <Button variant="outline" onClick={() => void reload()}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }
  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={false}
      customLoading={loading || refreshing}
      onRefresh={() => void refresh()}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={[
        {
          id: "custom",
          title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
          items: navigationItems,
        },
      ]}
      selectedNodeKey={
        selectedProvider ? createCustomProviderNodeKey(selectedProvider.providerId) : null
      }
      onSelectNavItem={(item) => {
        if (item.type === "custom") setSelectedProviderId(item.provider.providerId);
        setTemplatePickerOpen(false);
      }}
      onReorderProviderIds={(providerIds) => saveDisplayOrder({ providerIds })}
      reorderableProviderIds={reorderableProviderIds}
    >
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => handleCreateProvider({ templateId })}
          onCreateCustom={(providerName) => handleCreateProvider({ providerName })}
        />
      ) : selectedProvider ? (
        <InlineEditableProviderCard
          key={selectedProvider.providerId}
          provider={selectedProvider}
          settingsRevision={providerSettingsView?.revision}
          onSave={async (provider) => {
            await saveProvider(provider);
          }}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={
            reorderableProviderIds?.has(selectedProvider.providerId)
              ? () =>
                  confirmAndDeleteModelProvider({
                    provider: selectedProvider,
                    confirmDialog,
                    intl,
                    deleteProvider,
                  })
              : undefined
          }
          onReorderModelIds={(modelIds) =>
            reorderProviderModels(selectedProvider.providerId, modelIds)
          }
          onTestModel={testModelConnectivity}
          nameEditable
        />
      ) : (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: loading ? "common.loading" : "settings.modelProvider.addProviderAction",
          })}
        </p>
      )}
    </ModelProviderSectionLayout>
  );
}
