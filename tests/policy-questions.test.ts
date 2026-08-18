/**
 * 题库常量的自洽棘轮（#236 语义层）。
 *
 * 定稿见 MindWeave《权限策略中心-题库草案》第二版。这里钉住的都是「破了会悄悄出事」
 * 的性质——题库是展示层，写错不会 500，只会让剧组配出他们以为没配的东西。
 *
 * 最要紧的一条是**声明完整性**：每个答案必须说明「选了它之后这件事还能被谁做」。
 * 它**不是能力存在性证明**——拿到一个键有四条通道（自动定式 / 区间自确认 /
 * 审批发行·直接授权 / 旁路），策略只管第一条；能力可经区间通道拿到，而区间逐演出
 * 可配，所以「有没有人能做 X」根本无法静态证明。真正防住的是：**某个答案在设计时
 * 压根没想过「关掉之后谁来做」**。
 */

import { describe, it, expect } from "vitest";
import {
  POLICY_QUESTIONS, QUESTION_COVERED_KEYS, questionKeys, matchAnswer,
} from "@/lib/policy-questions";
import { POLICY_KEYS, policyDef, isLegalValue } from "@/lib/policy-keys";

const defaults = (): Map<string, string> =>
  new Map(POLICY_KEYS.map((d) => [d.key, d.defaultValue]));

describe("题库与键表对齐", () => {
  it("答案里的键都存在，取值都合法", () => {
    const bad: string[] = [];
    for (const q of POLICY_QUESTIONS) {
      for (const a of q.answers) {
        for (const [k, v] of Object.entries(a.values)) {
          if (!policyDef(k)) bad.push(`${q.id}/${a.id}: 未知键 ${k}`);
          else if (!isLegalValue(k, v)) bad.push(`${q.id}/${a.id}: ${k} 不接受 ${v}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("同一题的各答案必须覆盖**同一组键**", () => {
    // 否则选 A 再选 B 会残留 A 独有的键，配出两个答案都不是的状态
    const bad: string[] = [];
    for (const q of POLICY_QUESTIONS) {
      const all = questionKeys(q);
      for (const a of q.answers) {
        for (const k of all) {
          if (!(k in a.values)) bad.push(`${q.id}/${a.id} 缺键 ${k}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("一个键最多归属一道题", () => {
    // 两道题共管同一个键 ⇒ 答另一题会静默改掉这一题的答案
    const owner = new Map<string, string>();
    const bad: string[] = [];
    for (const q of POLICY_QUESTIONS) {
      for (const k of questionKeys(q)) {
        const prev = owner.get(k);
        if (prev) bad.push(`${k} 同时属于 ${prev} 与 ${q.id}`);
        else owner.set(k, q.id);
      }
    }
    expect(bad).toEqual([]);
  });

  it("题 id 与答案 id 唯一", () => {
    const qids = POLICY_QUESTIONS.map((q) => q.id);
    expect(qids.length).toBe(new Set(qids).size);
    for (const q of POLICY_QUESTIONS) {
      const aids = q.answers.map((a) => a.id);
      expect(aids.length, `${q.id} 答案 id 重复`).toBe(new Set(aids).size);
    }
  });

  it("每题至少两个互斥答案", () => {
    for (const q of POLICY_QUESTIONS) expect(q.answers.length, q.id).toBeGreaterThanOrEqual(2);
  });
});

describe("声明完整性（不是能力存在性）", () => {
  it("每个答案都声明了「选了它之后这件事还能被谁做」", () => {
    const bad = POLICY_QUESTIONS.flatMap((q) =>
      q.answers.filter((a) => a.disposition.length === 0).map((a) => `${q.id}/${a.id}`));
    expect(bad).toEqual([]);
  });

  it("closesFeature 是唯一合法的「无去向」，且只用在出口题上", () => {
    const closing = POLICY_QUESTIONS.flatMap((q) =>
      q.answers.filter((a) => a.disposition.some((d) => d.kind === "closesFeature"))
        .map((a) => `${q.id}/${a.id}`));
    // 目前只有「是否允许生成对外分享链接 → 不允许」——它关的是功能本身，
    // 不是把权柄挪给别人。将来若有第二处，先想清楚它是不是真的「没有人能做」。
    expect(closing).toEqual(["share_token/no"]);
  });

  it("出口题必须标 danger（UI 要显著警示）且带后果文案", () => {
    const q = POLICY_QUESTIONS.find((x) => x.id === "share_token")!;
    expect(q.danger).toBe(true);
    expect(q.help).toContain("立即使所有已发出的链接失效");
  });

  it("去向声明里不得出现 role name / dept 名", () => {
    // ROLE_NAMES 是默认模版名单**不是白名单**，剧组可删可改名——拿 role 当持钥方
    // 是把保障建在流沙上。「跟组舞监」不同：它是 event_stage_manager 里的 per-event
    // 数据，指派了就存在，是动作角色。
    const FORBIDDEN = ["舞台监督", "助理舞台监督", "后台舞台监督", "制作人", "导演", "编剧"];
    const bad: string[] = [];
    for (const q of POLICY_QUESTIONS) {
      for (const a of q.answers) {
        for (const d of a.disposition) {
          const label = "label" in d ? d.label : "";
          for (const f of FORBIDDEN) {
            if (label.includes(f)) bad.push(`${q.id}/${a.id}: 「${label}」含 role 名 ${f}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("耦合键必须同题设定", () => {
  it("任务归属：*@delete 与 orphan_task_disposition 在同一题", () => {
    const q = POLICY_QUESTIONS.find((x) => x.id === "task_ownership")!;
    const keys = questionKeys(q);
    expect(keys).toContain("task.dept_poc:*@delete");
    expect(keys).toContain("policy.orphan_task_disposition");
  });

  it("每个答案的两键取值自洽——配不出「部门拥有 ＋ 别人替它清理」", () => {
    const q = POLICY_QUESTIONS.find((x) => x.id === "task_ownership")!;
    for (const a of q.answers) {
      const owns = a.values["task.dept_poc:*@delete"] === "on";
      const disposition = a.values["policy.orphan_task_disposition"];
      // 部门拥有 ⇒ 别人不得替它决定生死，只能留孤儿
      if (owns) expect(disposition, `${a.id} 自相矛盾`).toBe("keep");
    }
  });
});

describe("默认配置下每题都命中某个预设答案", () => {
  it("开箱即用不该显示「自定义」", () => {
    const cur = defaults();
    const unmatched = POLICY_QUESTIONS
      .filter((q) => matchAnswer(q, cur) === null)
      .map((q) => q.id);
    expect(unmatched).toEqual([]);
  });

  it("手改出一个混合态 ⇒ matchAnswer 返回 null（第四态「自定义」）", () => {
    const q = POLICY_QUESTIONS.find((x) => x.id === "participant_list")!;
    const cur = defaults();
    // 只翻其中一个键：任何预设答案都不该命中
    cur.set("event.creator:assignees@create", "off");
    expect(matchAnswer(q, cur)).toBeNull();
  });
});

describe("覆盖与分组", () => {
  it("题库覆盖的键都在键表里，其余键靠高级模式逐键", () => {
    const known = new Set(POLICY_KEYS.map((d) => d.key));
    expect([...QUESTION_COVERED_KEYS].filter((k) => !known.has(k))).toEqual([]);
    expect(QUESTION_COVERED_KEYS.size).toBeLessThan(POLICY_KEYS.length);
  });

  it("每题都有非空分组与题面", () => {
    for (const q of POLICY_QUESTIONS) {
      expect(q.group.trim(), q.id).not.toBe("");
      expect(q.title.trim(), q.id).not.toBe("");
    }
  });
});
