/**
 * 演示项目专用的假数据。
 *
 * 只有 DEMO_PRODUCTION_ID 这一个项目会看到这些内容——财务 / 资产盘点两页尚未接真实
 * 数据源，页面版式先做出来了，但把 fixture 直接渲染给所有项目等于给真实剧组看别人的
 * 假账本。判定统一走 isDemoProduction()，接上真实数据后连这个文件一起删。
 */
export const DEMO_PRODUCTION_ID = "demo-misty-harbor";

export function isDemoProduction(productionId: string): boolean {
  return productionId === DEMO_PRODUCTION_ID;
}

export const DEMO_FINANCE = {
  summary: [["¥750,000", "总预算"], ["¥380,000", "已使用"], ["¥370,000", "可用余额"], ["51%", "预算执行率"]] as const,
  categories: [
    { name: "创作与版权", budget: "¥120,000", used: "¥72,400", progress: 60 },
    { name: "舞美制作", budget: "¥280,000", used: "¥168,900", progress: 60 },
    { name: "演员与排练", budget: "¥190,000", used: "¥96,500", progress: 51 },
    { name: "宣传与场租", budget: "¥160,000", used: "¥43,200", progress: 27 },
  ],
  expenses: [
    ["舞台模型材料", "舞美制作", "¥8,600", "待审批"],
    ["A3 排练厅场租", "演员与排练", "¥12,000", "已入账"],
    ["终曲编曲首付款", "创作与版权", "¥18,000", "已入账"],
  ] as const,
};

export const DEMO_MATERIALS = {
  summary: [["42", "物料总数"], ["31", "可用"], ["6", "使用中"], ["5", "需处理"]] as const,
  items: [
    { code: "PR-014", name: "旧式黄铜航海罗盘", category: "道具", owner: "道具组", status: "已入库", location: "A-03" },
    { code: "CS-021", name: "林澈第二场深蓝风衣", category: "服装", owner: "服装组", status: "待修整", location: "C-12" },
    { code: "EQ-008", name: "手持船笛效果器", category: "设备", owner: "音响组", status: "排练中", location: "主剧场" },
    { code: "SC-005", name: "灯塔栏杆模块", category: "布景", owner: "舞美组", status: "制作中", location: "制作工坊" },
    { code: "PR-019", name: "无署名旧信件（8 份）", category: "道具", owner: "道具组", status: "已入库", location: "A-07" },
  ],
};
