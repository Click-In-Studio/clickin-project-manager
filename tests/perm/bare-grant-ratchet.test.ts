/**
 * 门语境裸 grant 查询棘轮（#604）。
 *
 * 病：owner 代码级旁路靠调用方自己写 `permCtx.isOwner || await hasGrant(...)`，
 * #228 / #246 两轮补漏后仍有几十个文件各写各的，漏 owner 的症状是「接口通但页面拒 /
 * 入口不亮」，每次都要线上撞出来才发现。
 *
 * 规则：`app/` 与 `components/` 下门语境一律 `hasEffectiveGrant` / `hasAnyEffectiveGrant`
 * （自带 owner 旁路）或 `requireGrantGate`。裸 `hasGrant` / `hasAnyGrant` /
 * `listGrantedResourceIds` 只允许在 `lib/` 内的判定核与 `*-perm.ts` 里出现
 * ——那两处不在本棘轮扫描范围。
 *
 * 记账表按文件记「当前裸调用数」，只降不升：
 *   - 某文件实际数 > 记账值 → 红（新增裸调用）；
 *   - 某文件实际数 < 记账值 → 红（收敛了就把记账值改下来，别让表撒谎）；
 *   - 表外文件出现裸调用 → 红。
 * 刻意不给 owner 旁路的裸调用要留在表里并在调用处加注释说明原因（#604 逐域收敛时处理）。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const BARE_CALL = /\b(?:hasGrant|hasAnyGrant|listGrantedResourceIds)\(/g;
const SCAN_ROOTS = ["app", "components"] as const;

/** 逐文件记账值：#604 第一批（admin 页面群）后的快照。只降不升。 */
const LEDGER: ReadonlyArray<readonly [string, number]> = [
  ["app/api/production/[id]/ai-usage/route.ts", 1],
  ["app/api/production/[id]/announcements/[announcementId]/read-status/route.ts", 1],
  ["app/api/production/[id]/announcements/[announcementId]/remind/route.ts", 1],
  ["app/api/production/[id]/announcements/[announcementId]/route.ts", 2],
  ["app/api/production/[id]/announcements/route.ts", 1],
  ["app/api/production/[id]/archive/route.ts", 1],
  ["app/api/production/[id]/assets/[assetId]/files/route.ts", 1],
  ["app/api/production/[id]/assets/[assetId]/route.ts", 2],
  ["app/api/production/[id]/assets/presign-probe/route.ts", 1],
  ["app/api/production/[id]/avatar/presign/route.ts", 1],
  ["app/api/production/[id]/characters/[charId]/route.ts", 2],
  ["app/api/production/[id]/characters/route.ts", 1],
  ["app/api/production/[id]/departments/[deptId]/chat/route.ts", 1],
  ["app/api/production/[id]/departments/[deptId]/members/route.ts", 2],
  ["app/api/production/[id]/departments/[deptId]/route.ts", 1],
  ["app/api/production/[id]/departments/route.ts", 1],
  ["app/api/production/[id]/events/[eventId]/tech-reqs/[reqId]/chat/route.ts", 1],
  ["app/api/production/[id]/import-joint/route.ts", 1],
  ["app/api/production/[id]/import-script/route.ts", 1],
  ["app/api/production/[id]/member-tags/[tagId]/route.ts", 1],
  ["app/api/production/[id]/member-tags/route.ts", 1],
  ["app/api/production/[id]/members/route.ts", 1],
  ["app/api/production/[id]/mention-resolve/route.ts", 1],
  ["app/api/production/[id]/mention-users/route.ts", 1],
  ["app/api/production/[id]/milestones/[milestoneId]/route.ts", 2],
  ["app/api/production/[id]/milestones/route.ts", 1],
  ["app/api/production/[id]/node/[nodeId]/route.ts", 2],
  ["app/api/production/[id]/permissions/route.ts", 1],
  ["app/api/production/[id]/platform-channel/route.ts", 2],
  ["app/api/production/[id]/resource-approvers/route.ts", 2],
  ["app/api/production/[id]/roles/[roleId]/copy/route.ts", 1],
  ["app/api/production/[id]/roles/[roleId]/permissions/route.ts", 1],
  ["app/api/production/[id]/roles/[roleId]/route.ts", 1],
  ["app/api/production/[id]/roles/route.ts", 2],
  ["app/api/production/[id]/route.ts", 6],
  ["app/api/production/[id]/scene-table-views/[viewId]/default/route.ts", 1],
  ["app/api/production/[id]/scene-table-views/[viewId]/route.ts", 2],
  ["app/api/production/[id]/scene-table-views/route.ts", 2],
  ["app/api/production/[id]/scenes/[sceneId]/route.ts", 3],
  ["app/api/production/[id]/scenes/route.ts", 1],
  ["app/api/production/[id]/script/block-search/route.ts", 1],
  ["app/api/production/[id]/tag-groups/[groupId]/options/[optionId]/route.ts", 2],
  ["app/api/production/[id]/tag-groups/[groupId]/options/route.ts", 1],
  ["app/api/production/[id]/tag-groups/[groupId]/route.ts", 2],
  ["app/api/production/[id]/tag-groups/route.ts", 2],
  ["app/api/script/[id]/block-tags/route.ts", 2],
  ["app/api/script/[id]/comments/route.ts", 1],
  ["app/api/script/[id]/pages/route.ts", 1],
  ["app/api/script/[id]/presence/route.ts", 1],
  ["app/api/script/[id]/route.ts", 3],
  ["app/api/script/[id]/stream/route.ts", 1],
  ["app/production/[id]/assets/[assetId]/preview/page.tsx", 1],
  ["app/production/[id]/assets/page.tsx", 1],
  ["app/production/[id]/characters/[charId]/page.tsx", 2],
  ["app/production/[id]/characters/page.tsx", 1],
  ["app/production/[id]/contacts/page.tsx", 1],
  ["app/production/[id]/dramaturgy/page.tsx", 1],
  ["app/production/[id]/events/[eventId]/callsheet/page.tsx", 1],
  ["app/production/[id]/events/[eventId]/page.tsx", 1],
  ["app/production/[id]/events/[eventId]/reqs/page.tsx", 2],
  ["app/production/[id]/events/[eventId]/view/page.tsx", 4],
  ["app/production/[id]/import-scenes/page.tsx", 1],
  ["app/production/[id]/import-script/page.tsx", 1],
  ["app/production/[id]/reports/[reportId]/page.tsx", 3],
  ["app/production/[id]/script/page.tsx", 3],
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function countBareCalls(): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const n = (stripComments(readFileSync(full, "utf8")).match(BARE_CALL) ?? []).length;
      if (n > 0) out.set(relative(process.cwd(), full), n);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(process.cwd(), root));
  return out;
}

describe("棘轮：app/ components/ 下门语境不得新增裸 hasGrant / hasAnyGrant / listGrantedResourceIds", () => {
  it("逐文件裸调用数不得超过记账值；收敛后记账值同步调低", () => {
    const actual = countBareCalls();
    const ledger = new Map(LEDGER);
    const problems: string[] = [];
    for (const [file, n] of actual) {
      const recorded = ledger.get(file);
      if (recorded === undefined) problems.push(`${file}: 表外新增 ${n} 处裸调用——改用 hasEffectiveGrant 族`);
      else if (n > recorded) problems.push(`${file}: ${recorded} → ${n}，新增裸调用——改用 hasEffectiveGrant 族`);
      else if (n < recorded) problems.push(`${file}: ${recorded} → ${n}，已收敛，请把记账值改为 ${n}`);
    }
    for (const [file] of ledger) {
      if (!actual.has(file)) problems.push(`${file}: 已无裸调用，请从记账表删除`);
    }
    expect(problems).toEqual([]);
  });
});
