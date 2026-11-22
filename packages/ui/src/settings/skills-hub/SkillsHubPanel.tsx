import { RefreshCcw, Sparkles, Unlink } from "lucide-react";
import type { SkillsHubConflict, SkillsHubState } from "@zcode/shared/skills-hub";
import { formatSkillHubSourceLabel } from "@zcode/shared/skills-hub";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SkillSourceBadge } from "./SkillSourceBadge.js";

const PRUNE_PREVIEW_LIMIT = 10;
const NEW_SKILL_PREVIEW_LIMIT = 8;

export interface SkillsHubPanelProps {
  state: SkillsHubState | null;
  busy: boolean;
  error: string | null;
  onSync: () => void;
  onPrune: (entryNames: string[]) => void;
  onChoose: (nameKey: string, realDir: string | null) => void;
  onDismissNew: () => void;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function ConflictRow({
  conflict,
  busy,
  onChoose,
}: {
  conflict: SkillsHubConflict;
  busy: boolean;
  onChoose: SkillsHubPanelProps["onChoose"];
}) {
  const { intl } = useZCodeIntl();
  const pluginLabel = intl.formatMessage({ id: "settings.skills.hub.source.plugin" });
  return (
    <li className="space-y-1.5 px-3 py-2.5" data-skills-hub-conflict={conflict.nameKey}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{conflict.name}</span>
        {conflict.userChosen ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-foreground-subtle"
            disabled={busy}
            onClick={() => onChoose(conflict.nameKey, null)}
          >
            {intl.formatMessage({ id: "settings.skills.hub.conflicts.reset" })}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-1">
        {conflict.variants.map((variant) => {
          const chosen = samePath(variant.realDir, conflict.chosenRealDir);
          const isDefault = samePath(variant.realDir, conflict.defaultRealDir);
          return (
            <li key={variant.realDir} className="flex min-w-0 items-center gap-2">
              <SkillSourceBadge
                label={formatSkillHubSourceLabel(variant.source, pluginLabel)}
                className="rounded-sm"
              />
              <span
                className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtle"
                title={variant.realDir}
              >
                {variant.realDir}
              </span>
              {isDefault ? (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: "settings.skills.hub.conflicts.default" })}
                </span>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant={chosen ? "secondary" : "outline"}
                disabled={busy || chosen}
                aria-pressed={chosen}
                onClick={() => onChoose(conflict.nameKey, variant.realDir)}
              >
                {intl.formatMessage({
                  id: chosen
                    ? "settings.skills.hub.conflicts.inUse"
                    : "settings.skills.hub.conflicts.use",
                })}
              </Button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** 设置 → 技能（用户范围）顶部的外部技能同步面板。状态只来自 useSkillsHub。 */
export function SkillsHubPanel({
  state,
  busy,
  error,
  onSync,
  onPrune,
  onChoose,
  onDismissNew,
}: SkillsHubPanelProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  if (state && !state.available) return null;
  const pruneCandidates = state?.pruneCandidates ?? [];
  const conflicts = state?.conflicts ?? [];
  const newSkills = state?.newSkills ?? [];
  const failedCount = state?.issues.length ?? 0;
  const pluginLabel = intl.formatMessage({ id: "settings.skills.hub.source.plugin" });

  const handlePrune = async () => {
    const preview = pruneCandidates.slice(0, PRUNE_PREVIEW_LIMIT).map(
      (candidate) =>
        `• ${candidate.entryName}（${intl.formatMessage({
          id: `settings.skills.hub.prune.reason.${candidate.reason}`,
        })}）`,
    );
    if (pruneCandidates.length > PRUNE_PREVIEW_LIMIT) {
      preview.push(
        intl.formatMessage(
          { id: "settings.skills.hub.prune.more" },
          { count: pruneCandidates.length - PRUNE_PREVIEW_LIMIT },
        ),
      );
    }
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.skills.hub.prune.confirmTitle" }),
      description: intl.formatMessage(
        { id: "settings.skills.hub.prune.confirmDescription" },
        { list: preview.join("\n") },
      ),
      confirmLabel: intl.formatMessage({ id: "settings.skills.hub.prune.confirm" }),
      confirmVariant: "destructive",
      intent: "skills-hub-prune",
    });
    if (confirmed) onPrune(pruneCandidates.map((candidate) => candidate.entryName));
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-card-border bg-card px-4 py-3"
      data-skills-hub-panel="true"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.skills.hub.title" })}
          </h3>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.skills.hub.description" })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {pruneCandidates.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void handlePrune()}
            >
              <Unlink data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage(
                { id: "settings.skills.hub.prune" },
                { count: pruneCandidates.length },
              )}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onSync}>
            <RefreshCcw
              data-icon="inline-start"
              aria-hidden="true"
              className={busy ? "animate-spin motion-reduce:animate-none" : undefined}
            />
            {intl.formatMessage({
              id: busy ? "settings.skills.hub.syncing" : "settings.skills.hub.syncNow",
            })}
          </Button>
        </div>
      </div>

      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.skills.hub.engineNote" })}
      </p>

      {state ? (
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage(
            { id: "settings.skills.hub.syncedSummary" },
            { count: state.managedLinkCount },
          )}
          {state.createdCount > 0 || state.removedCount > 0
            ? ` · ${intl.formatMessage(
                { id: "settings.skills.hub.syncChanged" },
                { created: state.createdCount, removed: state.removedCount },
              )}`
            : ""}
        </p>
      ) : null}

      {error ? (
        <p className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "settings.skills.hub.error" }, { message: error })}
        </p>
      ) : null}
      {failedCount > 0 ? (
        <p className="text-ui-sm text-amber-500">
          {intl.formatMessage({ id: "settings.skills.hub.issues" }, { count: failedCount })}
        </p>
      ) : null}

      {newSkills.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2">
          <Sparkles className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "settings.skills.hub.newSkills" },
              { count: newSkills.length },
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {newSkills.slice(0, NEW_SKILL_PREVIEW_LIMIT).map((skill) => (
              <span key={skill.nameKey} className="inline-flex items-center gap-1">
                <span className="text-ui-sm text-foreground-subtle">{skill.name}</span>
                <SkillSourceBadge
                  label={formatSkillHubSourceLabel(skill.source, pluginLabel)}
                  className="rounded-sm"
                />
              </span>
            ))}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDismissNew}>
            {intl.formatMessage({ id: "settings.skills.hub.newSkills.dismiss" })}
          </Button>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "settings.skills.hub.conflicts.title" },
              { count: conflicts.length },
            )}
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.skills.hub.conflicts.description" })}
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {conflicts.map((conflict) => (
              <ConflictRow
                key={conflict.nameKey}
                conflict={conflict}
                busy={busy}
                onChoose={onChoose}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
