export type RoleGroup = { label: string; roles: string[] };

export const ROLE_GROUPS: RoleGroup[] = [
  { label: "boss",     roles: ["制作人", "制作助理"] },
  { label: "创作组",   roles: ["编剧", "编剧助理", "戏剧构作", "导演", "副导演", "导演助理", "作曲", "作曲助理", "编曲"] },
  { label: "设计组",   roles: ["舞美设计", "舞美设计助理", "灯光设计", "灯光设计助理", "多媒体设计", "多媒体设计助理", "服化设计", "服化设计助理", "音响设计", "音响设计助理"] },
  { label: "执行组",   roles: ["技术导演", "灯光编程", "音响执行"] },
  { label: "舞台监督", roles: ["舞台监督", "助理舞台监督"] },
  { label: "宣发/外围", roles: ["新媒体", "侧写"] },
  { label: "演员",     roles: ["演员", "群演"] },
  { label: "特殊岗位", roles: ["肢体指导", "编舞"] },
];

export const ALL_ROLES = new Set(ROLE_GROUPS.flatMap((g) => g.roles));
