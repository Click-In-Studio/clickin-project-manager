# 剧本排版模版引擎（engrave epic #337 · 阶段 C）

> 内容写作与排版分离（Dorico 路径）。编辑器不跟排版走，最多给页码提示；排版引擎只面对打印管线一个消费者，页码估算器是它的一个近似。

## 0. 一句话

**模版 = 每类块怎么排（流模版）+ 什么时候变样（规则）+ 页面长什么样（页模版）。** 三者都是数据；预设是代码常量；演出（将来是每个本子）存「预设 id + 覆盖项」。

## 1. 为什么是这个形状

- epic 决策 6：流模版 = **可视化盒编辑 + 内容引用**，不是字符串 DSL。串式模版写不出「角色名放左栏 7.5rem」；今天的 `center` / `compact` 正好成为两个盒预设。
- epic 决策 7：规则条件必须看得到上下文（前一块、所在场、是否本页首块），否则连今天的角色名省略都复现不了。
- epic 决策 2：**不做元素级 override**。模版是块类型级的；唯一例外（手动重唱区）在 J。
- 目标格式差在**块的排法**，不在页种：百老汇音乐剧（角色名居中大写、台词通栏左起、歌词大写缩进、`JOHN (laughing)`、页码 `I – 1 – 51`）vs 中国话剧（「角色：台词」同行、舞台提示括号楷体）。页种（A4 / Letter / 边距）只是页模版里几个字段。

## 2. 数据模型

```ts
ScriptTemplate {
  id, name, version
  page:        { paper, margins, header: PageBand, footer: PageBand, toc: {...} }   // 页模版（G/F 的地盘，这里只放页眉页脚页码）
  typography:  { faces: { script, stage, lyric }, fontSize, lineHeight, indentUnit }
  blockStyles: Record<BlockStyleId, BlockStyle>   // dialogue / lyric / stage / sceneHeading / …
  rules:       Rule[]                              // 规则引擎（E 的地基）
  estimate?:   { … }                               // 估算器的兼容开关（只有 legacy 用）
}

BlockStyle {                     // 一类块怎么排 = 一个小网格 + 若干槽
  frame: { columns: [{ width: "7.5rem" | "1rem" | "1fr" | "auto" }], gapX }
  slots: Slot[]
  padding: { top, bottom }       // 块外沿
}
Slot {
  id: "character" | "stageComment" | "content" | "scene.number" | "scene.name" | "act.roman" | "scene.local" | …   // 内容引用
  field: 引用哪个字段
  box:   { col, row, colSpan, rowSpan? }    // 放哪；rowSpan "all" = 侧栏标签贯穿全行
  inline?: true                   // 同行有占格槽 → 前缀并入其首行（「角色：台词」）；同行全是 inline → 连成一条文字流（`JOHN (laughing)`）
  indent?: { left, right, firstLine }      // px（Samuel French 的「三个缩进」）
  when?: { maxChars, minChars }   // 字段长度门（短提示同行、长提示另起行）
  align, style: { face, size, lineHeight, weight, italic, underline, case, letterSpacing, color }
  decorate: { before, after }     // 「（」「）」/「：」/「ACT 」
  hideIfEmpty: true               // 字段空 → 连装饰一起隐藏（决策 6 要求保留的能力）
}
Rule { when: Predicate, then: Effect }
  Predicate（封闭枚举，不是表达式语言）:
    type / hasCharacters / prevSameCharacters / prevSameScene / prevSameRehearsalMark /
    forceShowCharacterName / isSceneStart / firstOnPage / nextSameCharacters …
  Effect:
    hide: [slotId] / show: [slotId] / padding / gapBefore / breakBefore: "page" / keepWithNext / suffix
```

**为什么规则是封闭枚举**：条件要在估算器（无 DOM）、测量层、预览三处一致地求值，且将来要画成界面；表达式语言三处都难。

## 3. 管线

```
blocks + scenes + characters
   │  plan(template)            ← 规则求值：每块得到 LayoutItem（哪些槽可见、装饰、外沿、断页提示；
   ▼                              以及「若是本页首块」的变体）
LayoutItem[]
   ├─ estimate(template) → 每块高度（几何：槽文字 / 列宽 → 行数 × 行高） ─┐
   ├─ measure(DOM)       → 每块高度（渲染同一份 LayoutItem 到隐藏层实测） ─┤
   ▼                                                                       ▼
paginate(items, heights, page)   ← **同一个分页器**，两种高度来源
   │
   ▼
pages → render(TemplateBlock, PageChrome)
```

- **一个分页器**：今天 `computePageMap`（估算）与 `computePrintPages`（DOM 实测）是两套算法，连「说话人切换的 10px 间距」都一个算一个不算。引擎里分页算法只有一份，差别只在高度来源。双轨要不要合、权威值从哪来仍归 #349——这里只是让两轨至少走同一条路。
- **一个块渲染器**：今天预览与测量层各有一份 `renderBlock`，必须手工保持一致。引擎里 `TemplateBlock` 只有一份，两处都用它。
- **页首变体**：「本页首块要把省略的角色名补回来」这类规则让同一块有两种高度。plan 产出 `variants.pageTop`，测量层对有差异的块多测一次，估算器多算一次。

## 4. legacy 模版：引擎的第一块试金石

`legacy-center` / `legacy-compact` 用模版数据复现今天的 `textLayoutMode` 两种输出。验收：

- 打印：B3 的 golden（`scripts/print-consistency/golden.json`）**不变**——它是今天输出的快照。
- 估算：`computePageMap` / `updateEstimatedPageMap` 对随机剧本的输出与旧实现**逐字节相同**（旧实现整份拷进测试当参照）。

今天的估算器有两个「不准」（compact 下角色名在侧栏却仍按一行计高；说话人间距 10px 不计）。为了存量演出的页码不在上线那天漂移，这两个 quirk 用 `template.estimate` 开关保留在 legacy 模版里，新模版一律走准确几何。

## 5. 存储与分层

- 预设：`lib/script-template/presets/*.ts`（代码常量，改它 = 改代码 = 走 PR，与 production-template 同一纪律）。
- 演出侧：`script_view.template_overrides = { templateId, …将来的覆盖项 }`（B2 留的列，零 DDL）。`text_layout_mode` 列继续存在，作为无 `templateId` 时的回退映射（center → `legacy-center@1`，compact → `legacy-compact@1`）。读写经 `ScriptConfig.templateId`（`loadProduction` / `saveScriptConfig` / config PUT），PUT 只认注册表里的 id。
- **预设按版本冻结**：id 形如 `broadway-musical@1`。改预设 = 发新版本（`@2`），演出存的是带版本的 id、由人主动升级。页码是剧组的共享坐标，不能因为我们调了一下间距就悄悄漂移（#349）。选择界面只列每个家族的最新版（`listTemplatePresets`）。
- **改模版 = 改全局页码**（#338 的要求）：打印页里选模版先只是预览，重新分页后把「共 N 页（当前模版 M 页，所有人的页码都会变）」摆在人眼前，再保存或撤销。保存后 `page_map` 按新模版重算。
- 演出级默认 → 本子级覆盖（决策 8）等 D 有多本时再加一层；现在只有主本。

## 6. 阶段

| | 内容 | 验收 |
|---|---|---|
| T1 | 引擎核心（类型 / plan / paginate / estimate）+ legacy 模版 + 估算器改吃引擎 | 估算与旧实现逐字节相同 |
| T2 | 渲染器 `TemplateBlock` / 页眉页脚 `PageChrome`，打印管线改吃引擎 | golden 不变 |
| T3 | 存储 + config API + 打印页模版选择（预览后保存） | 落库测试；golden 不变 |
| T4 | 百老汇音乐剧示范模版（Samuel French 规范）；顺手补原语：行内流（`JOHN (laughing)`）、缩进、`when` 长度门、幕/场字段、场次标题过规则（每场另起页）、页带字段化 | `tests/script-template-broadway.test.ts` 逐条对照；`golden-broadway.json` |
| T5+ | 中国话剧等模版；模版编辑界面（H 的可视化盒编辑器） | — |

## 7. 明确不在此处

并排台词（J）、页序列 / 杂页 / 首页（F+G）、插断（I）、规则编辑界面（E 的界面部分）、页码坐标语义（#349）。
