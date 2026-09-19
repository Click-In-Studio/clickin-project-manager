/**
 * 权限键人话棘轮（#541）。
 *
 * 病：激活弹窗 / 403 页 / 申请弹窗把 node:script/*\/blocks@view 原样吐给新成员——
 * 手写标签表只登记了 12 枚键，其余 101 枚裸奔。手写表永远追不上模板，
 * 所以改成按 `动词 + 资源名 + 子面` 三段拼接，三张小词表是真相源。
 *
 * 不变量：**模板与激活面目录发出去的每枚键，三段词表必须齐全**（或有手写覆盖）。
 * 缺一段就红——新加权限键时要么复用已登记的 type/sub/verb，要么补词表一行。
 * 不连库：模板常量就是键的真相源。
 */
import { describe, it, expect } from "vitest";
import { PRODUCTION_TEMPLATES } from "@/lib/production/production-template";
import { PAGE_PERMISSION_SCOPES } from "@/lib/perm/page-permission-scopes";
import {
  permissionLabel,
  permissionGroupLabel,
  permissionCategories,
  unlabelledParts,
  PERMISSION_LABELS,
} from "@/lib/perm/permission-labels";

/** 模板 + 激活面目录里声明的全部键（cue 受益相对键实例化成 cue_list 域键）。 */
function declaredKeys(): string[] {
  const keys = new Set<string>();
  for (const t of Object.values(PRODUCTION_TEMPLATES)) {
    t.roles.baseline.forEach((k) => keys.add(k));
    Object.values(t.roles.permissions).flat().forEach((k) => keys.add(k));
    Object.values(t.deptPermissions).flat().forEach((k) => keys.add(k));
    for (const row of t.cueDeclarations) {
      for (const rel of row.permissions ?? []) {
        const [sub, verb] = rel.split("@");
        keys.add(`node:cue_list/*${sub ? `/${sub}` : ""}@${verb}`);
      }
    }
  }
  for (const scope of Object.values(PAGE_PERMISSION_SCOPES)) {
    for (const k of scope) keys.add(k);
  }
  return [...keys].sort();
}

describe("permission label ratchet", () => {
  it("模板与激活面目录里的每枚键都能拼出完整人话", () => {
    const keys = declaredKeys();
    expect(keys.length).toBeGreaterThan(0);
    const missing = keys
      .map((k) => ({ key: k, parts: unlabelledParts(k) }))
      .filter(({ parts }) => parts.length > 0);
    expect(
      missing.map(({ key, parts }) => `${key} → 缺 ${parts.join(", ")}`),
      "补 lib/perm/permission-labels.ts 的词表（GROUP_LABELS / SUB_LABELS / VERB_LABELS）或手写 PERMISSION_LABELS",
    ).toEqual([]);
  });

  it("没有一枚键会被原样展示", () => {
    for (const k of declaredKeys()) {
      expect(permissionLabel(k), k).not.toBe(k);
      expect(permissionLabel(k), k).not.toContain("node:");
      expect(permissionLabel(k), k).not.toContain("@");
    }
  });

  it("手写表不藏死键：每条覆盖都在模板 / 目录里被用到", () => {
    const live = new Set(declaredKeys());
    const dead = Object.keys(PERMISSION_LABELS).filter((k) => !live.has(k));
    expect(dead, "手写覆盖只为在用的键服务；退役的键连同标签一起删").toEqual([]);
  });
});

describe("permissionLabel 拼接规则", () => {
  it("meta@view 是门票，说成「查看 X」", () => {
    expect(permissionLabel("node:scene/*/meta@view")).toBe("查看章节/段落");
    expect(permissionLabel("node:member/*/meta@view")).toBe("查看成员");
  });

  it("主面不带子面；有子面时 动词+资源+子面", () => {
    expect(permissionLabel("node:milestone/*@edit")).toBe("编辑里程碑");
    expect(permissionLabel("node:member/*/contact@view")).toBe("查看成员联系方式");
    expect(permissionLabel("node:scene/*/synopsis@edit")).toBe("编辑章节/段落梗概");
  });

  it("实例级 id 说成「此」", () => {
    expect(permissionLabel("node:wiki/w1/*@delete")).toBe("删除此文档");
    expect(permissionLabel("node:task/t1/*@edit")).toBe("编辑此任务");
  });

  it("通配键不显示星号", () => {
    expect(permissionLabel("node:*/*@*")).not.toContain("*");
    expect(permissionLabel("node:*/*/grants@*")).not.toContain("*");
    expect(permissionGroupLabel("node:*/*@*")).toBe("全部资源");
  });

  it("手写覆盖优先于拼接", () => {
    expect(permissionLabel("node:event/*/followers@create")).toBe("关注事件");
    expect(permissionLabel("node:script/*/blocks@view")).toBe("查看剧本");
  });

  it("兜底：未知段嵌进人话，不裸吐整枚键", () => {
    // 线上老数据可能带没登记过的子面 / 类型——棘轮拦得住模板，拦不住历史行
    expect(permissionLabel("node:scene/*/whatever@view")).toBe("查看章节/段落（whatever）");
    expect(permissionLabel("node:gizmo/*@view")).toBe("查看gizmo");
    expect(unlabelledParts("node:gizmo/*/whatever@view")).toEqual([
      "GROUP_LABELS.gizmo",
      "SUB_LABELS.whatever",
    ]);
    // 连键形都不对（原子键）才原样返回
    expect(permissionLabel("event:view")).toBe("event:view");
    expect(unlabelledParts("event:view")).toEqual(["PERMISSION_LABELS.event:view"]);
  });

  it("分组标题去重", () => {
    expect(permissionCategories([
      "node:scene/*/meta@view", "node:scene/*/synopsis@view", "node:member/*/meta@view",
    ])).toEqual(["章节/段落", "成员"]);
  });
});
