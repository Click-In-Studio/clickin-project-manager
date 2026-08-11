// "我的 ×××" 只读工具层——镜像 app/my/* 页面的数据面，全部 self-scoped：
// caller 身份来自插件强制覆写的 _caller_user_id，每个查询函数本身就以
// userId 收窄权限（与 my 页面同一批函数，无新权限面）。
// 全部 readOnlyHint: true → 插件门控直通，Level A（AI base）。

import { isoToDatetimeLocal, isoToDateInput } from "@/lib/tz";
import { getUserProfile, listMyProductionsWithRoles, listUpcomingMilestonesForUser } from "@/lib/db";
import {
  listMyUpcomingCallTimes,
  listMyTechReqsFull,
  listMyFollowedUpcomingEvents,
} from "@/lib/event-db";
import { ADMIN_PANEL_PERMISSIONS } from "@/lib/permissions";

const EMPTY = (what: string) => `（当前没有${what}）`;

/** my.call_times：我的近期通告（时间为 UTC+8）。 */
export async function myCallTimes(userId: string): Promise<string> {
  const rows = await listMyUpcomingCallTimes(userId);
  if (rows.length === 0) return EMPTY("即将到来的Call");
  return rows
    .slice(0, 20)
    .map((c) => {
      const when = isoToDatetimeLocal(c.callAt).replace("T", " ");
      const loc = c.eventLocation ? ` @ ${c.eventLocation}` : "";
      const notes = c.notes ? `（${c.notes}）` : "";
      return `- ${when}｜《${c.productionName}》${c.eventTitle}${loc}${notes}`;
    })
    .join("\n");
}

/** my.tech_reqs：与我相关的技术需求（被指派或作为部门 POC）。 */
export async function myTechReqs(userId: string): Promise<string> {
  const rows = await listMyTechReqsFull(userId);
  if (rows.length === 0) return EMPTY("与你相关的技术需求/任务");
  return rows
    .slice(0, 20)
    .map((r) => {
      const dept = r.departmentName ? `［${r.departmentName}］` : "";
      const poc = r.amPoc ? "（你是负责人）" : "";
      return `- ${dept}${r.title} — 状态：${r.status}${poc}｜《${r.productionName}》${r.eventTitle}`;
    })
    .join("\n");
}

/** my.events：我关注的即将开始的活动（时间为 UTC+8）。 */
export async function myFollowedEvents(userId: string): Promise<string> {
  const rows = await listMyFollowedUpcomingEvents(userId);
  if (rows.length === 0) return EMPTY("关注中的即将开始的 Event 事件");
  return rows
    .slice(0, 20)
    .map((e) => {
      const when = e.startTime ? `${isoToDatetimeLocal(e.startTime).replace("T", " ")}｜` : "";
      const loc = e.eventLocation ? ` @ ${e.eventLocation}` : "";
      return `- ${when}《${e.productionName}》${e.eventTitle}（${e.eventType}）${loc}`;
    })
    .join("\n");
}

/** my.milestones：我可见项目的临近里程碑。 */
export async function myMilestones(userId: string): Promise<string> {
  const profile = await getUserProfile(userId);
  if (!profile) return "没有找到你的用户档案。";
  const rows = await listUpcomingMilestonesForUser(userId, profile.isAdmin);
  if (rows.length === 0) return EMPTY("临近的项目里程碑");
  return rows
    .slice(0, 20)
    .map((m) => `- ${isoToDateInput(m.endDate)}｜《${m.productionName}》${m.name}`)
    .join("\n");
}

/** my.productions：我参与的全部制作（含已归档）与角色。 */
export async function myProductions(userId: string): Promise<string> {
  const profile = await getUserProfile(userId);
  if (!profile) return "没有找到你的用户档案。";
  const rows = await listMyProductionsWithRoles(userId, profile.isAdmin, [...ADMIN_PANEL_PERMISSIONS]);
  if (rows.length === 0) return EMPTY("参与的制作");
  return rows
    .slice(0, 30)
    .map((p) => {
      const roles = p.roles?.length ? p.roles.join("、") : "成员";
      const extra = [p.firstTag, p.isOwner ? "所有者" : null, p.archivedAt ? "已归档" : null]
        .filter(Boolean)
        .join("，");
      return `- 《${p.name}》：${roles}${extra ? `（${extra}）` : ""}`;
    })
    .join("\n");
}
