import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SKILL_SOURCE_FILTERS, type SkillHubSourceFilter } from "./contract.js";

/** 技能列表来源筛选：选中项用较强表面对比，不用品牌色块（DESIGN.md Tabs and Selection States）。 */
export function SkillSourceFilterBar({
  value,
  onChange,
}: {
  value: SkillHubSourceFilter;
  onChange: (next: SkillHubSourceFilter) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "settings.skills.hub.filter.label" })}
      className="flex flex-wrap items-center gap-1"
    >
      {SKILL_SOURCE_FILTERS.map((filter) => (
        <Button
          key={filter}
          type="button"
          size="sm"
          variant={filter === value ? "secondary" : "ghost"}
          aria-pressed={filter === value}
          className={filter === value ? "text-foreground" : "text-foreground-subtle"}
          onClick={() => onChange(filter)}
        >
          {intl.formatMessage({ id: `settings.skills.hub.filter.${filter}` })}
        </Button>
      ))}
    </div>
  );
}
