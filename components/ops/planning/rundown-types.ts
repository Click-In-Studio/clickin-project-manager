/**
 * 版面的一列。服务端由两张表拼出来：
 *   event_rundown_column  → id / 顺序 / visible / pinned(is_pinned) / matchLocation
 *   event_group           → name / 成员（部门 + 人）
 *
 * 没有 roleNames：role 是项目可配置表、会改名，落库会漂。角色 chip 保留在编辑器里，
 * 但语义是「按角色批量勾选人员」，落库的是具体的人。
 */
export type RundownColumn = {
  /** 服务端 event_rundown_column.id；本地新建尚未保存时是 `new-*` */
  id: string;
  /** people 列绑定的用户组 id；location 列为 null */
  groupId: string | null;
  name: string;
  kind: "people" | "location";
  departmentIds: string[];
  userIds: string[];
  /** location 列的匹配值（对应 event_schedule_item.location） */
  location: string;
  visible: boolean;
  /** 横向滚动时钉在左侧 → 服务端 is_pinned。与用户组的冻结快照无关。 */
  pinned: boolean;
};

export type ServerUserGroup = {
  id: string;
  name: string;
  members: { kind: "dept" | "user"; id: string }[];
};
export type ServerRundownColumn = {
  id: string; groupId: string | null; matchLocation: string | null;
  orderIndex: number; isVisible: boolean; isPinned: boolean;
};
export type ServerRundownPlacement = {
  entryType: "item" | "task"; entryId: string; color: string | null; pinnedColumnIds: string[];
};

export type RundownEntrySelection =
  | { kind: "item"; id: string }
  | { kind: "task"; id: string };

export type RundownDragEntry = RundownEntrySelection & { duration: number };
