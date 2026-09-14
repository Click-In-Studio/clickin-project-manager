"use client";

import { createContext } from "react";

/**
 * 导航 pending 广播。
 *
 * 侧栏高亮由 usePathname() 推导，而 pathname 要等服务端 RSC payload 回来
 * 才变——点击后一段时间内高亮纹丝不动，用户以为没点上就反复点（每点一次
 * 都会让服务端把那页的权限 + DB 查询重跑一遍）。这里把「正在去哪」提前
 * 广播出来：目标项立刻拿到 active 视觉，原项立刻失活。
 */
export type NavPendingBus = { href: string | null; report: (href: string, pending: boolean) => void };
export const NavPendingContext = createContext<NavPendingBus>({ href: null, report: () => {} });
