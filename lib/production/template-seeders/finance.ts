/**
 * 项目模版 · 财务科目 slot。
 *
 * 这里只初始化科目字典，不创建「科目 × 部门」预算项：预算项代表项目真的决定
 * 在某个部门使用该科目，应由项目按需建立；默认预算仍是 NULL（无上限）。
 */
import { randomBytes } from "node:crypto";
import type { TemplateSeeder } from "../production-template";

export type ExpenseCategoriesPayload = readonly string[];

export const COMMON_EXPENSE_CATEGORIES = [
  "交通费",
  "餐饮费",
  "住宿费",
  "打印费",
  "运输物流费",
  "设备租赁费",
  "场地租赁费",
  "耗材采购费",
  "临时劳务费",
  "宣传推广费",
] as const;

export const THEATRE_EXPENSE_CATEGORIES = [
  ...COMMON_EXPENSE_CATEGORIES,
  "搭建费",
  "服化制作费",
  "道具制作费",
] as const;

export const PERFORMANCE_EXPENSE_CATEGORIES = [
  ...COMMON_EXPENSE_CATEGORIES,
  "搭建费",
  "舞台制作费",
] as const;

export const FILM_EXPENSE_CATEGORIES = [
  ...COMMON_EXPENSE_CATEGORIES,
  "置景制作费",
  "后期制作费",
] as const;

export const MUSIC_VIDEO_EXPENSE_CATEGORIES = [
  ...COMMON_EXPENSE_CATEGORIES,
  "置景制作费",
  "后期制作费",
] as const;

export const MUSIC_EXPENSE_CATEGORIES = [
  ...COMMON_EXPENSE_CATEGORIES,
  "录音棚租赁费",
  "乐手劳务费",
  "混音母带费",
] as const;

export const RADIO_DRAMA_EXPENSE_CATEGORIES = [
  ...COMMON_EXPENSE_CATEGORIES,
  "录音棚租赁费",
  "配音劳务费",
  "后期制作费",
] as const;

const newExpenseCategoryId = () => `ec_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

export const expenseCategoriesSeeder: TemplateSeeder<ExpenseCategoriesPayload> = {
  slot: "expenseCategories",
  label: "费用科目",

  validate(names) {
    const errors: string[] = [];
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (!name.trim()) errors.push(`第 ${index + 1} 个科目名称为空`);
      if (name !== name.trim()) errors.push(`科目名称前后不能有空格：${JSON.stringify(name)}`);
      if (seen.has(name)) errors.push(`科目名称重复：${name}`);
      seen.add(name);
    });
    return errors;
  },

  async seed(names, ctx) {
    for (const [index, name] of names.entries()) {
      await ctx.db.query(
        `INSERT INTO production_expense_category
           (id, production_id, name, sort_order, created_by)
         SELECT $1, p.id, $2, $3, p.owner_id
           FROM production p WHERE p.id = $4
         ON CONFLICT (production_id, name) DO NOTHING`,
        [newExpenseCategoryId(), name, index, ctx.productionId],
      );
    }
  },
};
