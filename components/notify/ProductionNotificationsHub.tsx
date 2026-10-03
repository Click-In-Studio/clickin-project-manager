"use client";

import MyNotificationsClient from "@/components/notify/MyNotificationsClient";
import ProductionAnnouncementsClient from "@/components/notify/ProductionAnnouncementsClient";
import styles from "@/components/ui/my-pages.module.css";

type Announcement = {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
};

type Props = {
  productionId: string;
  productionName: string;
  announcements: Announcement[];
  announcementReadIds: string[];
};

export default function ProductionNotificationsHub({
  productionId,
  productionName,
  announcements,
  announcementReadIds,
}: Props) {
  return (
    <div className={styles.notificationHubWorkspace}>
      <div className={styles.notificationHub}>
        <ProductionAnnouncementsClient
          compact
          productionId={productionId}
          productionName={productionName}
          initialAnnouncements={announcements}
          initialReadIds={announcementReadIds}
        />
        <MyNotificationsClient
          compact
          productions={[{ id: productionId, name: productionName }]}
          productionId={productionId}
        />
      </div>
    </div>
  );
}
