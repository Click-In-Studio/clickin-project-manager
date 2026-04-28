import type { Metadata } from "next";
import { BASE_PATH } from "@/lib/base-path";
import FeishuLoginClient from "@/components/FeishuLoginClient";

export const metadata: Metadata = { title: "登录" };

export default function LoginPage() {
  return <FeishuLoginClient appId={process.env.FEISHU_APP_ID ?? ""} basePath={BASE_PATH} />;
}
