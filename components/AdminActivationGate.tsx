"use client";
import { useState } from "react";
import { usePendingPermissions } from "@/hooks/usePendingPermissions";
import PermissionActivationModal from "@/components/PermissionActivationModal";
import { ADMIN_PANEL_PERMISSIONS } from "@/lib/permissions";

type Props = {
  productionId: string;
  children: React.ReactNode;
};

/**
 * Client gate for the admin panel.
 * On mount, checks if the user has any selfConfirmable ADMIN_PANEL_PERMISSIONS.
 * If yes, shows a one-click activation modal before the user proceeds.
 * Does not block page render — the modal overlays the already-rendered content.
 */
export default function AdminActivationGate({ productionId, children }: Props) {
  const { pending, confirming, confirm } = usePendingPermissions(productionId, ADMIN_PANEL_PERMISSIONS);
  const [dismissed, setDismissed] = useState(false);

  const showModal = !dismissed && pending !== null && pending.length > 0;

  return (
    <>
      {children}
      {showModal && (
        <PermissionActivationModal
          pending={pending}
          confirming={confirming}
          onConfirm={async (perms) => {
            await confirm(perms);
            setDismissed(true);
          }}
          onDismiss={() => setDismissed(true)}
          title="激活管理权限"
          subtitle="你在此项目中拥有以下管理权限，进入前请一键激活："
        />
      )}
    </>
  );
}
