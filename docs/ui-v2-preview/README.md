# Click-In 2.0 UI/UX 原型评审图库

本目录用于团队直接在 GitHub 评审 Click-In 2.0 的信息架构、关键交互和响应式布局。页面使用固定模拟数据，不连接生产数据库、正式 API 或真实用户信息。

## 快速总览

| 桌面端（1440 × 1000） | 手机端（390 × 844） |
| --- | --- |
| ![桌面端总览](overview/desktop-contact-sheet.png) | ![手机端总览](overview/mobile-contact-sheet.png) |

推荐评审顺序：角色首页 → 项目导航 → Event / Task / Notification → Calendar / Gantt / Timetable → 手机现场操作。

## 完整状态图库

| # | 状态 | 桌面端 | 手机端 |
| --- | --- | --- | --- |
| 01 | 制作人 / 舞监首页 | ![](desktop/01-home-producer-stage-manager.png) | ![](mobile/01-home-producer-stage-manager.png) |
| 02 | 导演 / 构作首页 | ![](desktop/02-home-director-dramaturg.png) | ![](mobile/02-home-director-dramaturg.png) |
| 03 | 设计 / 技术首页 | ![](desktop/03-home-design-technical.png) | ![](mobile/03-home-design-technical.png) |
| 04 | 演员首页 | ![](desktop/04-home-actor.png) | ![](mobile/04-home-actor.png) |
| 05 | 项目首页 | ![](desktop/05-project-home.png) | ![](mobile/05-project-home.png) |
| 06 | 剧本 | ![](desktop/06-script.png) | ![](mobile/06-script.png) |
| 07 | 构作 | ![](desktop/07-dramaturgy.png) | ![](mobile/07-dramaturgy.png) |
| 08 | 表格 | ![](desktop/08-table.png) | ![](mobile/08-table.png) |
| 09 | 数字资产 | ![](desktop/09-digital-assets.png) | ![](mobile/09-digital-assets.png) |
| 10 | Cue | ![](desktop/10-cue.png) | ![](mobile/10-cue.png) |
| 11 | 人员与角色 | ![](desktop/11-people-and-roles.png) | ![](mobile/11-people-and-roles.png) |
| 12 | Event | ![](desktop/12-events.png) | ![](mobile/12-events.png) |
| 13 | Task | ![](desktop/13-tasks.png) | ![](mobile/13-tasks.png) |
| 14 | Notification | ![](desktop/14-notifications.png) | ![](mobile/14-notifications.png) |
| 15 | 财务 | ![](desktop/15-finance.png) | ![](mobile/15-finance.png) |
| 16 | 实体物料 | ![](desktop/16-materials.png) | ![](mobile/16-materials.png) |
| 17 | Calendar | ![](desktop/17-calendar.png) | ![](mobile/17-calendar.png) |
| 18 | Gantt | ![](desktop/18-gantt.png) | ![](mobile/18-gantt.png) |
| 19 | Timetable | ![](desktop/19-timetable.png) | ![](mobile/19-timetable.png) |
| 20 | 产品框架说明 | ![](desktop/20-framework.png) | ![](mobile/20-framework.png) |
| 21 | Task 详情抽屉 | ![](desktop/21-task-drawer.png) | ![](mobile/21-task-drawer.png) |
| 22 | Cue 详情抽屉 | ![](desktop/22-cue-drawer.png) | ![](mobile/22-cue-drawer.png) |
| 23 | Notification 详情抽屉 | ![](desktop/23-notification-drawer.png) | ![](mobile/23-notification-drawer.png) |
| 24 | 创建 Event：定义 Event | ![](desktop/24-event-create-step-1.png) | ![](mobile/24-event-create-step-1.png) |
| 25 | 创建 Event：确认 Task | ![](desktop/25-event-create-step-2.png) | ![](mobile/25-event-create-step-2.png) |
| 26 | 创建 Event：发布与通知 | ![](desktop/26-event-create-step-3.png) | ![](mobile/26-event-create-step-3.png) |
| 27 | Event 发布成功 | ![](desktop/27-event-published-success.png) | ![](mobile/27-event-published-success.png) |

## 设计目标

- 用“我的工作”回答不同角色今天最需要处理什么。
- 在项目内保持“剧本侧 / 舞台侧”两组清晰入口，同时让同一对象只保留一份数据。
- 以 Event → Task → Notification 形成创建、分工、告知、确认与追踪闭环。
- 用 Calendar、Gantt、Timetable 分别承载总览、长线计划和分钟级现场执行。
- 桌面端服务复杂编排与批量处理；手机端服务现场查看、确认和快速完成。

## 本地运行

```powershell
npm install
npm run dev -- --hostname 127.0.0.1
```

打开：`http://127.0.0.1:3000/app/prototype/ui-v2`

原型还支持以查询参数直接打开模块，例如：`/app/prototype/ui-v2?view=framework`。可用值包括 `home`、`project`、`script`、`dramaturgy`、`table`、`assets`、`cue`、`people`、`events`、`tasks`、`notifications`、`planning`、`finance`、`materials` 和 `framework`。

## 评审边界

这是信息架构和关键交互原型，不代表最终视觉品牌、完整权限系统、生产数据模型或完整财务流程。评审建议优先聚焦入口是否清晰、对象关联是否合理、角色首页排序是否符合现场工作，以及手机端是否能快速完成高频动作。
