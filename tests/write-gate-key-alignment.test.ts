import { describe, expect, it } from "vitest";
import {
  characterPermsFromRows,
  ALL_CHARACTER_PERMS,
  NO_CHARACTER_PERMS,
} from "@/lib/character-perms";
import { sceneFieldPermsFromRows } from "@/lib/scene-field-perms";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";

/**
 * 前端写面开关与判定端路由门必须同键。
 *
 * 回归的病：角色页用一枚 `character/*@edit` 当总门，同时决定「添加」表单、行内
 * 编辑态和「删除」按钮；构作页用 `SceneFieldPerms.any` 当总门，同时决定「+ 新建
 * 场次」「转换类型」「删除」。而判定端 create / edit / delete / meta/type 是四条
 * 不同的路由门——持钥人组合一旦不是模板发的那套全集，前端就会显示一个必然 403
 * 的按钮，或藏起一个本该可用的入口。
 */

const row = (sub: string, verb: string) => ({ resource_sub: sub, permission_level: verb });

describe("character 三枚键互不蕴含", () => {
  it("只有 create：看得见「添加」，看不见行内编辑与删除", () => {
    const perms = characterPermsFromRows([row("*", "create")]);
    expect(perms).toEqual({ create: true, edit: false, delete: false, any: true });
  });

  it("只有 edit：看得见行内编辑，看不见「添加」与「删除」", () => {
    const perms = characterPermsFromRows([row("*", "edit")]);
    expect(perms).toEqual({ create: false, edit: true, delete: false, any: true });
  });

  it("只有 delete：只看得见「删除」", () => {
    const perms = characterPermsFromRows([row("*", "delete")]);
    expect(perms).toEqual({ create: false, edit: false, delete: true, any: true });
  });

  it("模板发的全集三枚齐活；无行则三枚全无", () => {
    expect(characterPermsFromRows([row("*", "create"), row("*", "edit"), row("*", "delete")]))
      .toEqual(ALL_CHARACTER_PERMS);
    expect(characterPermsFromRows([])).toEqual(NO_CHARACTER_PERMS);
  });

  it("view 行不喂任何写面开关", () => {
    expect(characterPermsFromRows([row("meta", "view"), row("biography", "view")]))
      .toEqual(NO_CHARACTER_PERMS);
  });
});

describe("scene：any 是粗门，不蕴含 create / delete / kind", () => {
  it("只持 synopsis@edit —— any 为真，但新建 / 删除 / 转换类型全假", () => {
    const perms = sceneFieldPermsFromRows([row("synopsis", "edit")]);
    expect(perms.any).toBe(true);
    expect(perms.synopsis).toBe(true);
    expect(perms.create).toBe(false);
    expect(perms.delete).toBe(false);
    expect(perms.kind).toBe(false);
  });

  it("scene/*@create 不顺带给出 edit 类的字段门", () => {
    const perms = sceneFieldPermsFromRows([row("*", "create")]);
    expect(perms.create).toBe(true);
    expect(perms.delete).toBe(false);
    expect(perms.structure).toBe(false);
    expect(perms.name).toBe(false);
    expect(perms.kind).toBe(false);
  });

  it("sub 通配行覆盖全部字段门（保留段不在 scene 域内）", () => {
    const perms = sceneFieldPermsFromRows([row("*", "edit")]);
    expect(perms.name).toBe(true);
    expect(perms.kind).toBe(true);
    expect(perms.music).toBe(true);
    expect(perms.structure).toBe(true);
    // edit 不蕴含 create / delete
    expect(perms.create).toBe(false);
    expect(perms.delete).toBe(false);
  });
});

describe("激活面收齐了这些写面键", () => {
  it("character 三枚都在 characters scope 里（否则持区间者永远激活不出行）", () => {
    for (const verb of ["create", "edit", "delete"]) {
      expect(PAGE_PERMISSION_SCOPES.characters.has(`node:character/*@${verb}`)).toBe(true);
    }
  });

  it("scene 的 create / edit / delete 都在 dramaturgy scope 里", () => {
    for (const verb of ["create", "edit", "delete"]) {
      expect(PAGE_PERMISSION_SCOPES.dramaturgy.has(`node:scene/*@${verb}`)).toBe(true);
    }
  });
});
