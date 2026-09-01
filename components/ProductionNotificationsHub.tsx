"use client";

import PageHeader from "@/components/PageHeader";
import MyNotificationsClient from "@/components/MyNotificationsClient";
import ProductionAnnouncementsClient from "@/components/ProductionAnnouncementsClient";
import styles from "@/components/my-pages.module.css";

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
  const unreadAnnouncements = announcements.filter((item) => !announcementReadIds.includes(item.id)).length;

  return (
    <div className={styles.notificationHubWorkspace}>
      <PageHeader
        eyebrow={productionName}
        title={
          <span className={styles.notificationHubTitle}>
            我的通知
            {unreadAnnouncements > 0 && <em>{unreadAnnouncements} 条公告未读</em>}
          </span>
        }
        side="stage"
      />

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
