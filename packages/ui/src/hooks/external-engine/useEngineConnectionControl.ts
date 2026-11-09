import { useCallback, useRef, useState } from "react";
import {
  defaultEngineConnectionProfileId,
  isExternalSessionEngine,
  type ExternalSessionEngine,
  type SessionEngine,
} from "@zcode/shared/external-engine";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import type { EngineConnectionChoice } from "@/external-engine/contract.js";
import {
  engineConnectionModeLabel,
  engineConnectionProfileName,
  findEngineConnectionView,
  visibleEngineConnectionProfiles,
} from "@/external-engine/connectionProfileLabels.js";
import { useEngineConnectionProfiles } from "./useEngineConnectionProfiles.js";
import type { ExternalEngineServiceHandle } from "./useExternalEngineService.js";

interface DraftSelection {
  engine: ExternalSessionEngine;
  profileId: string;
}

/**
 * 输入框的连接配置选择：草稿可改选，已创建会话只读显示绑定。
 * 绑定事实只来自 snapshot.config.engineConnectionProfileId；草稿改选在新预热回流前显示所选值，
 * 选择本身经 Host 命令记为上次使用，并通过 draftConnectionProfileId 交给现有草稿 owner 重建预热。
 */
export function useEngineConnectionControl(params: {
  service: ExternalEngineServiceHandle | undefined;
  engine: SessionEngine;
  /** null 表示草稿。 */
  sessionId: string | null;
  /** 当前 snapshot 投影的绑定（仅当 snapshot 属于同一引擎）。 */
  boundProfileId: string | undefined;
  /** 草稿改选后回收并重建预热。 */
  onDraftSelected: () => void;
}) {
  const { service, engine, sessionId, boundProfileId, onDraftSelected } = params;
  const external = isExternalSessionEngine(engine) ? engine : undefined;
  const { connections, update } = useEngineConnectionProfiles(external ? service : undefined);
  const { intl } = useZCodeIntl();
  const selectionRef = useRef<DraftSelection | null>(null);
  const [selection, setSelection] = useState<DraftSelection | null>(null);
  const select = useCallback(
    (profileId: string) => {
      if (sessionId !== null || !external) return;
      const next = { engine: external, profileId };
      selectionRef.current = next;
      setSelection(next);
      // 选择即刻用于重建预热；Host 记录上次使用失败时保留草稿与本次选择并提示。
      onDraftSelected();
      void update({ type: "select", engine: external, profileId }).catch(() => {
        toast(intl.formatMessage({ id: "engine.profile.selectFailed" }), { variant: "warning" });
      });
    },
    [sessionId, external, onDraftSelected, update, intl],
  );
  const draftConnectionProfileId = useCallback(
    () =>
      selectionRef.current && selectionRef.current.engine === external
        ? selectionRef.current.profileId
        : undefined,
    [external],
  );
  if (!external)
    return {
      choices: [],
      currentId: undefined,
      label: undefined,
      select,
      draftConnectionProfileId,
    };
  const choices: EngineConnectionChoice[] = visibleEngineConnectionProfiles(
    connections,
    external,
  ).map((profile) => ({
    id: profile.id,
    name: profile.builtIn
      ? intl.formatMessage({ id: `engine.profile.builtin.${profile.id}` })
      : engineConnectionProfileName(intl, profile),
    description: [engineConnectionModeLabel(intl, profile.mode), profile.gatewayHost]
      .filter(Boolean)
      .join(" · "),
  }));
  const pending = selection?.engine === external ? selection.profileId : undefined;
  const currentId =
    sessionId === null
      ? (pending ?? boundProfileId ?? connections?.defaults[external])
      : boundProfileId;
  // 已创建会话只读显示非缺省绑定；内置缺省（Codex 沿用 CLI、Claude 官方登录）不占用工具栏。
  const bound =
    sessionId !== null && boundProfileId !== defaultEngineConnectionProfileId(external)
      ? findEngineConnectionView(connections, external, boundProfileId)
      : undefined;
  const label = bound
    ? bound.builtIn
      ? intl.formatMessage({ id: `engine.profile.builtin.${bound.id}` })
      : engineConnectionProfileName(intl, bound)
    : undefined;
  return { choices, currentId, label, select, draftConnectionProfileId };
}
