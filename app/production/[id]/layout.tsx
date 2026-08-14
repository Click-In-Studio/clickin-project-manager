import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getWatermarkInfo } from "@/lib/db";
import WatermarkOverlay from "@/components/WatermarkOverlay";

/** production 全部页面的共享 layout：按项目配置渲染访问者水印。 */
export default async function ProductionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  let watermark: { name: string; email: string | null } | null = null;
  if (session) {
    const info = await getWatermarkInfo(id, session.userId);
    if (info.enabled) watermark = { name: info.name || session.name, email: info.email };
  }

  return (
    <>
      {children}
      {watermark && <WatermarkOverlay name={watermark.name} email={watermark.email} />}
    </>
  );
}
