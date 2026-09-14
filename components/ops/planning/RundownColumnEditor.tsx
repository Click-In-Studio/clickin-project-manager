"use client";

import { useEffect, useState } from "react";
import styles from "@/components/ops/planning.module.css";
import DropdownPicker, { type DropdownPickerItem } from "@/components/ui/DropdownPicker";
import type { RundownColumn } from "./rundown-types";
import type { PlanningDept, PlanningMember } from "./types";

/**
 * 「个人」下拉行：按部门分组（header 行 + 成员挂组；跨部门成员在各组各出现一行，
 * 行 id 合成唯一、value=userId 共享勾选态；无部门成员进「未分配部门」组）。
 * 与 ProductionTasksClient 的参与人下拉同构。
 */
function memberPickerItems(members: PlanningMember[], departments: PlanningDept[]): DropdownPickerItem[] {
  const items: DropdownPickerItem[] = [];
  const grouped = new Set<string>();
  const row = (member: PlanningMember, rowId: string, parentId: string): DropdownPickerItem => ({
    id: rowId,
    value: member.userId,
    parentId,
    label: member.name || "（未命名）",
    sublabel: member.roles.join(" · ") || undefined,
  });
  for (const dept of departments) {
    const inDept = members.filter(member => member.departmentIds.includes(dept.id));
    if (inDept.length === 0) continue;
    items.push({ id: `d:${dept.id}`, label: dept.name, header: true, parentId: null });
    for (const member of inDept) {
      items.push(row(member, `d:${dept.id}:${member.userId}`, `d:${dept.id}`));
      grouped.add(member.userId);
    }
  }
  const rest = members.filter(member => !grouped.has(member.userId));
  if (rest.length > 0) {
    items.push({ id: "d:__none", label: "未分配部门", header: true, parentId: null });
    for (const member of rest) items.push(row(member, `d:__none:${member.userId}`, "d:__none"));
  }
  return items;
}

export function RundownColumnEditor({ column, departments, members, roles, onChange, onRename, onToggleValue, onToggleRole, onDelete, onClose }: {
  column: RundownColumn;
  departments: PlanningDept[];
  members: PlanningMember[];
  roles: string[];
  /** 只改展示属性（显隐 / 粘性）——不落用户组 */
  onChange: (patch: Partial<RundownColumn>) => void;
  /** 改名 = 改用户组，失焦时才发，不然每敲一个字打一次请求 */
  onRename: (name: string) => void;
  onToggleValue: (key: "departmentIds" | "userIds", value: string) => void;
  onToggleRole: (role: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState(column.name);
  useEffect(() => { setDraftName(column.name); }, [column.id, column.name]);
  const roleSelections = roles.filter(role => {
    const roleUserIds = members.filter(member => member.roles.includes(role)).map(member => member.userId);
    return roleUserIds.length > 0 && roleUserIds.every(userId => column.userIds.includes(userId));
  });
  return (
    <div className={styles.columnEditor} role="dialog" aria-label={`编辑人员组 ${column.name}`} onClick={event => event.stopPropagation()}>
      <div className={styles.inlineEditorHeader}>
        <b>编辑人员组</b>
        <button type="button" onClick={onClose} aria-label="关闭人员组编辑">×</button>
      </div>
      <label className={styles.inlineField}>人员组名称
        <input
          value={draftName}
          onChange={event => setDraftName(event.target.value)}
          onBlur={() => { if (draftName.trim() && draftName !== column.name) onRename(draftName.trim()); }}
        />
      </label>
      <button type="button" className={styles.menuAction} onClick={() => onChange({ pinned: !column.pinned })}>
        <span>{column.pinned ? "▣" : "▢"}</span>
        <span><b>{column.pinned ? "取消钉住此列" : "钉住此列"}</b><small>横向滚动时保持在左侧</small></span>
      </button>
      <div className={styles.optionSection}>
        <b>部门</b>
        <DropdownPicker
          multi
          items={departments.map(department => ({ id: department.id, label: department.name }))}
          values={new Set(column.departmentIds)}
          placeholder={departments.length === 0 ? "暂无部门" : "选择部门"}
          searchPlaceholder="搜索部门…"
          disabled={departments.length === 0}
          multiCountLabel={n => `已选 ${n} 个部门`}
          onChange={() => {}}
          onToggle={id => onToggleValue("departmentIds", id)}
        />
      </div>
      {/* 角色是「按角色批量勾人」的快捷方式，不落库——role 是项目可配置表，会改名。
          选中态由「该角色的人是否都已在名单里」推导。 */}
      <div className={styles.optionSection}>
        <b>按角色批量选人</b>
        <DropdownPicker
          multi
          items={roles.map(role => ({ id: role, label: role }))}
          values={new Set(roleSelections)}
          placeholder={roles.length === 0 ? "暂无角色" : "选择角色"}
          searchPlaceholder="搜索角色…"
          disabled={roles.length === 0}
          multiCountLabel={n => `已选 ${n} 个角色`}
          onChange={() => {}}
          onToggle={onToggleRole}
        />
      </div>
      <div className={styles.optionSection}>
        <b>个人</b>
        <DropdownPicker
          multi
          items={memberPickerItems(members, departments)}
          values={new Set(column.userIds)}
          placeholder={members.length === 0 ? "暂无成员" : "选择个人"}
          searchPlaceholder="搜索姓名 / 角色…"
          disabled={members.length === 0}
          onChange={() => {}}
          onToggle={id => onToggleValue("userIds", id)}
        />
      </div>
      <div className={styles.columnEditorFooter}>
        <button type="button" className={styles.deleteAction} onClick={onDelete}>删除此人员组</button>
        <button type="button" className={styles.primaryEditorAction} onClick={onClose}>完成</button>
      </div>
    </div>
  );
}
