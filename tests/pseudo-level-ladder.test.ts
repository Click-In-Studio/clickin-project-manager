/**
 * 伪级别翻译层的一致性棘轮（#236 张力 2，2026-08-18）。
 *
 * 张力原文：`deriveNodePseudoLevel` / `*_LEVEL_ROW_SETS` 是给人看的翻译——模型早已
 * 纯动词行（M-2 权限非线性，判定端零等级比较）。**翻译表分叉 = 权限事故，目前只靠
 * 「只有一份」约束住**。
 *
 * 本文件不移除翻译层（那是更大的重构），而是把「只有一份」和「阶梯自洽」从口头约定
 * 变成机器判据——张力真正的危险是分叉，不是翻译层本身存在。
 *
 * 两条性质：
 *
 *   ① **单一事实源**：六张表只在 lib/resource-grant-db.ts 定义一次；
 *      lib/approval-routing.ts 的 LEVEL_ROW_SETS_BY_TYPE 直接引用它们，
 *      不得自建映射。授权发行与「上级有没有这个权限」共用同一份（M-12）。
 *
 *   ② **阶梯自洽**：`view ⊆ edit ⊆ manage`（按行集包含），且 manage 含 grants@edit。
 *      这是 deriveNodePseudoLevel 那三段顺序判断（grants@edit ⇒ manage、
 *      editSubs@edit ⇒ edit、viewSubs@view ⇒ view）能成立的前提：若某个类型的
 *      edit 档不含 view 档的行，一个只被授了 edit 档的人反解出来仍是 edit（没问题），
 *      但若 manage 不含 edit 的行，manage 持有者会被反解成更低档——UI 显示的档位
 *      与实际持有的行对不上，那就是「翻译表分叉」的第一种形态。
 *
 * 注意 ② **不是**在给权限模型引入等级蕴含：判定端仍然逐行精确匹配（M-2）。
 * 这里约束的只是**伪级别表自身**的内部一致性——它是展示层的词汇。
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  CUE_LIST_LEVEL_ROW_SETS, EVENT_LEVEL_ROW_SETS, TASK_LEVEL_ROW_SETS,
  REPORT_LEVEL_ROW_SETS, NOTE_LEVEL_ROW_SETS, WIKI_LEVEL_ROW_SETS,
} from "@/lib/resource-grant-db";

type RowSet = ReadonlyArray<readonly [string, string]>;
type Sets = Record<string, RowSet>;

const ALL: Record<string, Sets> = {
  cue_list: CUE_LIST_LEVEL_ROW_SETS as unknown as Sets,
  event: EVENT_LEVEL_ROW_SETS as unknown as Sets,
  task: TASK_LEVEL_ROW_SETS as unknown as Sets,
  report: REPORT_LEVEL_ROW_SETS as unknown as Sets,
  note: NOTE_LEVEL_ROW_SETS as unknown as Sets,
  wiki: WIKI_LEVEL_ROW_SETS as unknown as Sets,
};

const rowId = (r: readonly [string, string]): string => `${r[0]}@${r[1]}`;
const idsOf = (rows: RowSet): Set<string> => new Set(rows.map(rowId));

describe("伪级别阶梯自洽（张力 2）", () => {
  it("每个类型都有 view / edit / manage 三档", () => {
    for (const [type, sets] of Object.entries(ALL)) {
      for (const lvl of ["view", "edit", "manage"]) {
        expect(sets[lvl], `${type} 缺 ${lvl} 档`).toBeDefined();
      }
    }
  });

  it("view ⊆ edit ⊆ manage（行集包含，非等级蕴含）", () => {
    const bad: string[] = [];
    for (const [type, sets] of Object.entries(ALL)) {
      const [v, e, m] = [idsOf(sets.view), idsOf(sets.edit), idsOf(sets.manage)];
      for (const id of v) if (!e.has(id)) bad.push(`${type}: view 的 ${id} 不在 edit 档里`);
      for (const id of e) if (!m.has(id)) bad.push(`${type}: edit 的 ${id} 不在 manage 档里`);
    }
    expect(bad).toEqual([]);
  });

  it("manage 档必含 grants@edit——deriveNodePseudoLevel 认这一枚作为 manage 的判据", () => {
    for (const [type, sets] of Object.entries(ALL)) {
      expect(idsOf(sets.manage).has("grants@edit"), `${type} 的 manage 档缺 grants@edit`).toBe(true);
    }
  });

  it("四保留段不被 '*' 通配代替：manage 档要发保留段就得显式写出来（M-3）", () => {
    const reserved = ["grants", "publication", "assignees", "imports"];
    for (const [type, sets] of Object.entries(ALL)) {
      for (const [sub] of sets.manage) {
        if (sub === "*") continue;
        // 保留段只能整段出现，不能写成 grants/xxx 这种子路径（三层树硬约束 M-10）
        if (reserved.some((r) => sub.startsWith(`${r}/`))) {
          throw new Error(`${type} 的 manage 档出现保留段子路径 ${sub}`);
        }
      }
    }
  });
});

describe("单一事实源（张力 2 的真正危险：翻译表分叉）", () => {
  it("六张 *_LEVEL_ROW_SETS 只在 lib/resource-grant-db.ts 定义", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const rel = full.replace(process.cwd() + "/", "");
        if (rel === "lib/resource-grant-db.ts") continue;
        const text = readFileSync(full, "utf8");
        // 定义（export const X_LEVEL_ROW_SETS = ...）而非引用
        if (/(export\s+)?const\s+\w*LEVEL_ROW_SETS\s*[:=]/.test(text)) offenders.push(rel);
      }
    };
    for (const root of ["lib", "app"]) walk(join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });

  it("approval-routing 的类型映射引用那六张表，不自建", () => {
    const src = readFileSync("lib/approval-routing.ts", "utf8");
    // import 自 resource-grant-db
    expect(src).toMatch(/from\s+"\.\/resource-grant-db"/);
    for (const name of [
      "CUE_LIST_LEVEL_ROW_SETS", "EVENT_LEVEL_ROW_SETS", "TASK_LEVEL_ROW_SETS",
      "REPORT_LEVEL_ROW_SETS", "NOTE_LEVEL_ROW_SETS", "WIKI_LEVEL_ROW_SETS",
    ]) {
      expect(src, `approval-routing 未引用 ${name}`).toContain(name);
    }
  });

  it("策略层裁的是写点，没有把开关裁到翻译表上（M-12）", () => {
    const src = readFileSync("lib/resource-grant-db.ts", "utf8");
    const i = src.indexOf("export const EVENT_LEVEL_ROW_SETS");
    const decl = src.slice(i, src.indexOf("};", i));
    // 表的声明体里不得出现任何策略读取——一旦出现，审批发行面就被连带裁掉了
    expect(decl).not.toMatch(/policy|isPolicyOn|getPolicyValue/i);
  });
});
