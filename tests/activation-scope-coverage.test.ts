import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getPool } from "@/lib/pg";
import { SCENE_FIELD_SUBS } from "@/lib/scene-field-perms";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import { parseNodeKey, isSensitiveNode, isRootNode } from "@/lib/grant-template";
import { PRODUCTION_TEMPLATES } from "@/lib/production-template";

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
  // ── 剧本域：模板已表达字段级意图，判定端尚未拆门 ────────────────────────
  // requiredPermissions 对 blocks 的插入 / 更新 / 删除一律给 blocks@edit，
  // 排练标记的四个动词也一律给 rehearsal_marks@create。模板发得比判定端细，
  // 与 scene 拆门前是同一种欠账（见 lib/scene-field-perms.ts 的由来）。
  // 哪天照 scene 的样子把 script 也拆到字段级，这些就该从豁免表移进
  // PAGE_PERMISSION_SCOPES.script。
  "node:script/*/blocks@create",
  "node:script/*/blocks@delete",
  "node:script/*/blocks/character@edit",
  "node:script/*/blocks/type@edit",
  "node:script/*/blocks/tags@edit",
  "node:script/*/blocks/position@edit",
  "node:script/*/rehearsal_marks@view",
  "node:script/*/rehearsal_marks@edit",
  "node:script/*/rehearsal_marks@delete",
  "node:script/*/rehearsal_marks/position@edit",
  // ── 三态内容面：只有 meta@view 是门票，内容面 view 判定端不查 ───────────
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

/**
 * 判定端把 (sub, verb) 经变量传进 hasGrant 的地方——静态扫描抓不到，逐条记明
 * 门在哪。加条目要附文件位置，「盲区表不藏死键」那条会盯着它不许沉淀成垃圾。
 */
const GUARD_LOOKUP_BLIND_SPOTS: readonly string[] = [
  // app/api/production/[id]/events/[eventId]/route.ts 的 REQ_NODE 映射：
  // publish → publication@create、revoke → publication@delete，
  // 经 [reqSub, reqVerb] 解构后传入 hasEffectiveGrant
  "node:event/*/publication@create",
  "node:event/*/publication@delete",
  // lib/asset/perm.ts canViewAsset(face)：face 变量 = "meta" | "file"
  "node:asset/*/file@view",
];

const GUARD_SOURCE_DIRS = ["app", "lib"];

function readGuardSources(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // 激活面自身不是判定端，否则这条棘轮会自我满足
      if (full.includes("page-permission-scopes")) continue;
      out.push(readFileSync(full, "utf8"));
    }
  };
  for (const dir of GUARD_SOURCE_DIRS) walk(dir);
  return out.join("\n");
}

/** 从源码里提取判定端真正查过的节点键。 */
function collectGuardedKeys(): Set<string> {
  const src = readGuardSources();
  const keys = new Set<string>();
  const add = (type: string, sub: string, verb: string): void => {
    keys.add(`node:${type}/*${sub === "*" ? "" : `/${sub}`}@${verb}`);
  };
  // hasGrant(user, prod, "type", <id>, "sub", "verb")
  for (const m of src.matchAll(/"([a-z_]+)",\s*[^,)]+,\s*"([^"]*)",\s*"(view|create|edit|delete)"/g)) {
    add(m[1], m[2], m[3]);
  }
  // hasAnyGrant(user, prod, "type", ["a", "b"], "verb")
  for (const m of src.matchAll(/"([a-z_]+)",\s*\[([^\]]*)\],\s*"(view|create|edit|delete)"/g)) {
    for (const s of m[2].matchAll(/"([^"]+)"/g)) add(m[1], s[1], m[3]);
  }
  // 源码里直接写死的节点串（lib/script-ops.ts 的 requiredPermissions 等）
  for (const m of src.matchAll(/"(node:[a-z_*]+\/[^"@]*@(?:view|create|edit|delete))"/g)) {
    keys.add(m[1]);
  }
  // scene 字段门经 SCENE_FIELD_SUBS 间接消费（lib/scene-field-perms.ts）
  for (const sub of Object.values(SCENE_FIELD_SUBS)) add("scene", sub, "edit");
  return keys;
}

describe("activation scope coverage", () => {
  it("模板发的每个可自确认键都有激活面入口", async () => {
    // 模板源 = 项目模版常量（grant_template 已退役 #163）：全部模版 × 全部角色
    const rows = Object.values(PRODUCTION_TEMPLATES).flatMap((t) => [
      ...t.roles.baseline.map((k) => ({ role_name: `${t.key}/*`, permission_key: k })),
      ...Object.entries(t.roles.permissions).flatMap(([role, keys]) =>
        keys.map((k) => ({ role_name: `${t.key}/${role}`, permission_key: k })),
      ),
    ]);

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

  /**
   * 反向棘轮：**激活面里的每个键，判定端都得真有一道门去查。**
   *
   * 正向那条（模板 → 激活面）防的是「区间落不成行」；这条防的是反面——
   * 激活面收了一个没人查的键，弹窗就会让用户勾选一个不存在的能力，而且
   * 键名拼错了也永远不会有人发现（拼错的键既不会报错，也不会生效）。
   *
   * 判据分两档，对应判定端两种写法：
   *   - sub 具体（如 blocks@view）：要求源码里出现精确的 (type, sub, verb)
   *   - sub 通配（如 event/*@view）：整树通配区间，判定端查的是具体 sub，
   *     故只要求该 resource_type 在判定端出现过
   */
  it("激活面里的每个键，判定端都有对应的门", () => {
    const consumed = collectGuardedKeys();
    const consumedTypes = new Set([...consumed].map((k) => parseNodeKey(k)?.resourceType));

    const orphans = [...scopeUnion].filter((key) => {
      if (GUARD_LOOKUP_BLIND_SPOTS.includes(key)) return false;
      const n = parseNodeKey(key)!;
      return n.resourceSub === "*"
        ? !consumedTypes.has(n.resourceType)
        : !consumed.has(key);
    });

    expect(orphans).toEqual([]);
  });

  it("盲区表不藏死键：每条都还在源码里有痕迹", () => {
    const src = readGuardSources();
    const stale = GUARD_LOOKUP_BLIND_SPOTS.filter((key) => {
      const n = parseNodeKey(key)!;
      // 至少 resource_type 与 sub 的字面量还在源码里出现（防止豁免表沉淀成垃圾）
      return !(src.includes(`"${n.resourceType}"`) && src.includes(`"${n.resourceSub}"`));
    });
    expect(stale).toEqual([]);
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
