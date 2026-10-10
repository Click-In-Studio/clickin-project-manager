/** 个人历史只表达访问过哪些文档，不携带正文或阅读位置。 */
export type WikiRecentVisit = {
  wikiId: string;
  title: string | null;
  lastViewedAt: string;
};

export type WikiPersonalNavigation = {
  /** 保持 #916 已消费的响应结构；本轮没有置顶能力。 */
  pinned: [];
  recent: WikiRecentVisit[];
};
