---
# 复制本文件到 content/manual/<一级>/<二级>/<页>.md 后删掉这段注释。
# 字段契约与写法见 docs/DEV_GUIDE.md §12；CI 的 tests/help/manual-coverage.test.ts 会校验。
title: 页面标题（动宾短语，如「创建 Cue 表」）
order: 1                          # 同组内排序
summary: 一句话说明这页解决什么问题   # 列表、首页卡片、相关文章处显示
routes: [cuelists]                # 对应产品内路由（nav-config 口径）：cuelists / admin/roles / /my/tasks
who: 有「Cue 表管理」权限的成员      # 谁能用；不写 = 所有成员
tier: all                         # all | free | pro；写 pro 会显示「专业档可用」
platform: [desktop, mobile]       # 不写 = 两端都支持
related: []                       # 相关文章 slug，如 [creation/cues/link-to-script]
updated: 2026-09-18
---

<!--
写给谁：剧组里搞艺术的人——导演、舞监、演员、设计师。写法三条（DEV_GUIDE §12.3）：
1. 去技术化：不出现路由、代码、字段名、环境配置这类词；界面上的按钮和菜单用「」原样引用。
2. 只写现状，没有「如果」：这是我们自己部署的服务，功能有就是有、没有就是没有；配置变了改手册。
3. 站在读者那边：先说他要做什么、会看到什么，再说注意什么。
-->

## 这是什么

两三句话：这个功能帮你做什么、在产品里的位置（左侧栏「制作 → Cue」）。

## 怎么操作

1. 第一步。一步一图，截图放 `public/manual/<一级>/<文件名>.png`。

   ![截图说明](/manual/creation/cuelist-create.png)

2. 第二步。

> [!📱]
> 窄窗口下的差异写在这种提示里。

## 注意事项

> [!💡]
> 提示：容易踩的坑、和别的功能的联动。

- 权限 / 档位相关的限制。

## 常见问题

**问题写成一句话？**
答案。
