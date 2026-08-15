"use client";
import { useState } from "react";
import { usePendingPermissions } from "@/hooks/usePendingPermissions";
import PermissionActivationModal from "@/components/PermissionActivationModal";
import { PAGE_PERMISSION_SCOPES, type PageScope } from "@/lib/page-permission-scopes";

const PAGE_TITLES: Record<PageScope, string> = {
  base:        "开通查看权限",
  script:      "激活剧本权限",
  dramaturgy:  "激活构作权限",
  characters:  "激活角色权限",
  cuelists:    "激活 Cue 表权限",
  events:      "激活事件权限",
  reports:     "激活报告权限",
  assets:      "激活附件权限",
  wiki:        "激活文档权限",
};

const PAGE_SUBTITLES: Record<PageScope, string> = {
  base:        "你在此项目中拥有以下查看权限，一键开通后即可访问相应内容：",
  script:      "你在此项目中拥有以下剧本相关权限，进入前请一键激活：",
  dramaturgy:  "你在此项目中拥有以下场次 / 构作相关权限，进入前请一键激活：",
  characters:  "你在此项目中拥有以下角色相关权限，进入前请一键激活：",
  cuelists:    "你在此项目中拥有以下 Cue 表管理权限，进入前请一键激活：",
  events:      "你在此项目中拥有以下事件管理权限，进入前请一键激活：",
  reports:     "你在此项目中拥有以下报告管理权限，进入前请一键激活：",
  assets:      "你在此项目中拥有以下附件管理权限，进入前请一键激活：",
  wiki:        "你在此项目中拥有以下文档库权限，进入前请一键激活：",
};

type Props = {
  productionId: string;
  scope: PageScope;
};

/**
 * Drop in at the bottom of any server-page JSX to trigger a one-click
 * permission activation modal on first entry when the user has
 * selfConfirmable permissions in the given scope.
 *
 * Renders nothing when there are no pending permissions.
 */
export default function PageActivationGate({ productionId, scope }: Props) {
  const scopeSet = PAGE_PERMISSION_SCOPES[scope];
  const { pending, confirming, confirm } = usePendingPermissions(productionId, scopeSet);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || pending === null || pending.length === 0) return null;

  return (
    <PermissionActivationModal
      pending={pending}
      confirming={confirming}
      onConfirm={async (perms) => {
        await confirm(perms);
        setDismissed(true);
      }}
      onDismiss={() => setDismissed(true)}
      title={PAGE_TITLES[scope]}
      subtitle={PAGE_SUBTITLES[scope]}
    />
  );
}
