import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import { parseNodeKey, isSensitiveNode, isRootNode } from "@/lib/grant-template";

/**
 * 激活面覆盖棘轮。
 *
 * 不变量：**模板发出去的每个可自确认的键，都必须有一个激活面入口。**
 *
 * 权限只有两条落成 grant 行的路：自确认（区间 → 激活弹窗 → 行）与他人发行
 * （审批流 / 自动授权定式）。grant_template 发的键属于前者——模板的意思就是
 * 「这个角色有资格自己开通」。若这个键不在任何 PAGE_PERMISSION_SCOPES 里，
 * my-permissions 的 NODE_KEYS 就不含它，弹窗永远列不出它，POST 还会被
 * NODE_KEYS.includes 挡掉：区间永远变不成行，权限静默死掉。
 *
 * 这正是批D/E 的事故——四个 scope 被清空后只删不填，全库 33 人打不开剧本页，
 * 且没有任何测试会红。批B/C 的 event/notes 面也漏了五枚（2026-08-17 一并补）。
 *
 * 豁免只有两类，都写在下面并附理由。往 KNOWN_UNCONSUMED 里加条目前先问一句：
 * 是判定端真的没有这道门，还是激活面漏了？后者要补的是 scope，不是豁免表。
 */

/**
 * 判定端确无消费者的模板键——「模板 > 判定」的粒度差，不是激活面的缺口。
 * 给它们发行 grant 也没有任何门会去查，放进弹窗只会让用户勾选一个不存在的能力。
 *
 * 三态模型（总表 §0）只把 meta@view 当门票，内容面 view 目前不判权限：
 * 读投影时不做 per-face 过滤。哪天补上 per-face 门，这些键就该从豁免表移到
 * base scope 里去。
 */
const KNOWN_UNCONSUMED: readonly string[] = [
  "node:scene/*/synopsis@view",
  "node:scene/*/action_line@view",
  "node:scene/*/music@view",
  "node:scene/*/stage_notes@view",
  "node:character/*/gender@view",
  "node:character/*/biography@view",
  "node:character/*/role_type@view",
  "node:character/*/members@view",
  "node:production/*/meta@view",
  "node:production/*/mounts@view",
];

const scopeUnion = new Set<string>(
  Object.values(PAGE_PERMISSION_SCOPES).flatMap((s) => [...s] as string[]),
);

describe("activation scope coverage", () => {
  it("模板发的每个可自确认键都有激活面入口", async () => {
    const { rows } = await getPool().query<{ role_name: string; permission_key: string }>(
      "SELECT DISTINCT role_name, permission_key FROM grant_template ORDER BY 1, 2",
    );

    const missing: string[] = [];
    for (const { role_name, permission_key } of rows) {
      const node = parseNodeKey(permission_key);
      // type / verb 位通配的区间键（制作人五行）：它们能命中任意节点候选，
      // 落行由具体节点的激活面驱动，本身不进目录
      if (!node) continue;
      // SENSITIVE / ROOT 永不自确认（区间只是审批入口资格），不该进激活面
      if (isSensitiveNode(node.resourceType, node.resourceSub, node.verb)) continue;
      if (isRootNode(node.resourceType, node.resourceSub, node.verb)) continue;
      if (KNOWN_UNCONSUMED.includes(permission_key)) continue;
      if (!scopeUnion.has(permission_key)) missing.push(`${role_name} → ${permission_key}`);
    }

    expect(missing).toEqual([]);
  });

  it("豁免表不藏活键：KNOWN_UNCONSUMED 与激活面无交集", () => {
    const overlap = KNOWN_UNCONSUMED.filter((k) => scopeUnion.has(k));
    expect(overlap).toEqual([]);
  });

  it("激活面里的键都是合法节点串（能被 parseNodeKey 解析）", () => {
    const bad = [...scopeUnion].filter((k) => parseNodeKey(k) === null);
    expect(bad).toEqual([]);
  });

  it("激活面不含 SENSITIVE / ROOT 键（自确认管道会静默跳过它们）", () => {
    const forbidden = [...scopeUnion].filter((k) => {
      const n = parseNodeKey(k);
      if (!n) return false;
      return isSensitiveNode(n.resourceType, n.resourceSub, n.verb)
        || isRootNode(n.resourceType, n.resourceSub, n.verb);
    });
    expect(forbidden).toEqual([]);
  });
});
