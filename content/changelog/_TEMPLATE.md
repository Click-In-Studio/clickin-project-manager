---
# 复制本文件到 content/changelog/unreleased/<PR号>-<两三个词>.md 后删掉这段注释。
# 字段契约与写法见 docs/DEV_GUIDE.md §12.8；CI 的 tests/help/changelog.test.ts 会校验。
kind: new                        # new 新增 | improved 优化 | fixed 修复 | removed 下线
title: 日程日历里能直接改活动和任务了   # 必填，一句话，读者的语言（见下）
page: production/planning/calendar   # 对应手册页 slug → 渲染成「了解更多」；不写 = 没有对应页
pr: 566                          # 来源 PR 号，不给读者看
order: 1                         # 同版本同 kind 内排序，可不写
---

<!--
写给谁：和手册同一群人——导演、舞监、演员、设计师。写法与手册一致（DEV_GUIDE §12.3）：
1. 只写「你会看到什么变了」：不出现 issue 号、路径、代码、字段名；界面元素用「」原样引用。
2. 一条只说一件事。修复类写成「X 不再 Y」，不写「修复了 Z 逻辑」。
3. 内部改动（重构、CI、测试、依赖升级）不写条目，PR 打 chore 标签即可。
4. 正文可不写；要写就是一两句补充或一张截图，放 public/manual/ 下。
-->

打开日历里的活动或任务，右侧抽屉多了「编辑」。
