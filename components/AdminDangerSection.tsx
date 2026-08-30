"use client";

import { DangerCard, type SettingsPerms } from "@/components/AdminSettingsClient";

const NO_PERMS: SettingsPerms = {
  canRename: false, canChangeAvatar: false, canEditDescription: false,
  canChangeType: false, canChangeLanguage: false, canArchive: false, canDelete: false,
  canImportScript: false, canImportScenes: false,
  canManageTags: false, canToggleWatermark: false, canEditAiInstructions: false,
  canSeeAiUsage: false, canSeeAiUsageMembers: false,
};

export default function AdminDangerSection({
  productionId, productionName, isArchived, canArchive, canDelete,
}: {
  productionId: string;
  productionName: string;
  isArchived: boolean;
  canArchive: boolean;
  canDelete: boolean;
}) {
  return (
    <DangerCard
      productionId={productionId}
      productionName={productionName}
      isArchived={isArchived}
      perms={{ ...NO_PERMS, canArchive, canDelete }}
    />
  );
}
