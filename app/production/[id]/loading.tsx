import PageSkeleton from "@/components/PageSkeleton";

/**
 * 项目内全部页面（含 admin 子段）的 Suspense 边界。
 * 有了它，侧边栏切标签页才会「立刻切过去 + 显示加载中」，
 * 而不是阻塞在原页面等服务端 payload。
 */
export default function Loading() {
  return <PageSkeleton />;
}
