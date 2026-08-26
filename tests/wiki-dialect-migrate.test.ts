// 方言 v1 → v2 归一化：迁移脚本、编辑器载入兼容、历史版本渲染三处共用同一实现，
// 所以这层测试直接就是 migration 的正确性护栏。
import { describe, it, expect } from "vitest";
import { normalizeWikiDialect, hasLegacyDialect } from "@/lib/wiki-dialect-migrate";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("引用链接（§2.4 迁移映射）", () => {
  it("wiki 链接换形态，显示位保持哨兵", () => {
    expect(normalizeWikiDialect(`见 [#](/__cm__wiki:${UUID}) 一节`))
      .toBe(`见 [#](/__cm__/wiki/${UUID}) 一节`);
  });

  it("非 wiki kind 的编辑期 label 被塌成哨兵——不再把旧标题冻在正文里", () => {
    expect(normalizeWikiDialect("[#1-1 开场](/__cm__scene:sc_abc)"))
      .toBe("[#](/__cm__/scene/sc_abc)");
  });

  it("block.<mode> 点号语法 → as= 参数", () => {
    expect(normalizeWikiDialect("[#p.4-2](/__cm__block.page:blk_9)"))
      .toBe("[#](/__cm__/block/blk_9?as=page)");
  });

  it("版本钉住 ?v= 保留", () => {
    expect(normalizeWikiDialect("[#x](/__cm__scene:sc_a?v=ver_7)"))
      .toBe("[#](/__cm__/scene/sc_a?v=ver_7)");
  });

  it("asset 的第三段位置参数 :aux → aux= 参数", () => {
    expect(normalizeWikiDialect("[图纸](/__cm__asset:as_7:scene)"))
      .toBe("[#](/__cm__/asset/as_7?aux=scene)");
  });

  it("as / v / aux 同时出现时参数顺序固定（canonical，保真锁才不会误报）", () => {
    expect(normalizeWikiDialect("[#x](/__cm__block.scene:blk_1?v=ver_2:aux9)"))
      .toBe("[#](/__cm__/block/blk_1?as=scene&v=ver_2&aux=aux9)");
  });

  it("废弃裸 token → 链接形态", () => {
    expect(normalizeWikiDialect(`[#wiki:${UUID.toUpperCase()}]`))
      .toBe(`[#](/__cm__/wiki/${UUID})`);
  });
});

describe("@提及（线上 bug 的修复面）", () => {
  it("[@名](uid:x) → 引用 URI；label 保留（姓名无解析端点）", () => {
    expect(normalizeWikiDialect("辛苦 [@张三](uid:u_123) 跟进"))
      .toBe("辛苦 [@张三](/__cm__/user/u_123) 跟进");
  });

  it("更旧的 @[名](uid:x) 形态同样收敛", () => {
    expect(normalizeWikiDialect("@[李四](uid:u_9)")).toBe("[@李四](/__cm__/user/u_9)");
  });

  it("被 roundtrip bug 转义毁掉的形态也能救回来", () => {
    expect(normalizeWikiDialect("@\\[王五\\]\\(uid:u_5\\)")).toBe("[@王五](/__cm__/user/u_5)");
  });

  // 以下两条自退役的 tests/mention-normalize.test.ts 移植（那套 normalizeLegacyMentions
  // 已被本函数完全覆盖）：多重转义是 round-trip bug 反复施加的产物，线上见过。
  it("多重转义（二次 round-trip 损坏）也能救回来", () => {
    expect(normalizeWikiDialect("@\\\\[王五\\\\](uid:u_5)")).toBe("[@王五](/__cm__/user/u_5)");
  });

  it("被转义的引用链接先复原再收敛（显示位照例塌成哨兵）", () => {
    expect(normalizeWikiDialect(`\\[#标题\\](/__cm__wiki:${UUID})`))
      .toBe(`[#](/__cm__/wiki/${UUID})`);
  });

  it("无 id 的裸 @名字 不动（本来就没有指向）", () => {
    expect(normalizeWikiDialect("@某人 请看")).toBe("@某人 请看");
  });
});

describe("嵌入类与布局类", () => {
  it("图片换形态且保住 alt", () => {
    expect(normalizeWikiDialect("![剧照.jpg](/__cm__asset:as_1)"))
      .toBe("![剧照.jpg](/__cm__/asset/as_1)");
  });

  it("callout 管道参数 → k=v", () => {
    expect(normalizeWikiDialect("> [!🍰|#fff5eb]\n> 内容"))
      .toBe("> [!🍰 bg=#fff5eb]\n> 内容");
  });

  it("嵌套引用块里的 callout 一样处理", () => {
    expect(normalizeWikiDialect("> > [!📌|#abc]")).toBe("> > [!📌 bg=#abc]");
  });

  it("正文里的方括号不被误伤（只认引用块行首的 marker）", () => {
    const md = "这里写了 [!💡|#fff] 作为例子";
    expect(normalizeWikiDialect(md)).toBe(md);
  });

  it("分栏 fence 不受影响", () => {
    const md = ":::cols 46,54\n左\n\n---\n\n右\n:::";
    expect(normalizeWikiDialect(md)).toBe(md);
  });
});

describe("安全性质", () => {
  it("幂等：v2 正文再跑一遍原样返回（迁移可重跑、编辑器每次载入都跑）", () => {
    const v2 = [
      `[#](/__cm__/wiki/${UUID})`,
      "[@张三](/__cm__/user/u_1)",
      "![图](/__cm__/asset/as_1)",
      "> [!💡 bg=#fff5eb]",
      "[#](/__cm__/block/b1?as=page&v=v1)",
    ].join("\n\n");
    expect(normalizeWikiDialect(v2)).toBe(v2);
    expect(hasLegacyDialect(v2)).toBe(false);
  });

  it("代码块/行内码里的方言是语法示例，不改写", () => {
    const md = "示例：`[#](/__cm__wiki:x)`\n\n```\n[@名](uid:u1)\n```";
    expect(normalizeWikiDialect(md)).toBe(md);
  });

  it("解析不出来的私有 href 原样留着——绝不吃内容", () => {
    const md = "[#](/__cm__garbage-no-colon)";
    expect(normalizeWikiDialect(md)).toBe(md);
  });

  it("普通 markdown 链接与外链不动", () => {
    const md = "[文档](https://example.com/a?b=1) 与 [相对](/production/p1/wiki/x)";
    expect(normalizeWikiDialect(md)).toBe(md);
  });

  it("hasLegacyDialect 能识别待迁移正文", () => {
    expect(hasLegacyDialect(`[#](/__cm__wiki:${UUID})`)).toBe(true);
    expect(hasLegacyDialect("普通正文")).toBe(false);
  });
});
