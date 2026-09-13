// planAi / planAdvancedPerms 是**付费档位**开关（#280），与 canAdmin 那条权限维度正交：
// 权限决定视图里能看到什么内容，档位决定菜单里有没有这一项。两者都由服务端解析好下发
// （lib/account/plan.ts 的常量表不能进客户端包）。
export type Production = { id: string; name: string; archivedAt: string | null; roles: string[]; firstTag: string | null; canAdmin: boolean; avatarUrl: string | null; planAi: boolean; planAdvancedPerms: boolean };
export type ShellSession = { userId: string; name: string; avatarUrl: string | null };
