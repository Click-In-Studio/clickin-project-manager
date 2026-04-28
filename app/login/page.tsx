import { BASE_PATH } from "@/lib/base-path";
import FeishuLoginClient from "@/components/FeishuLoginClient";

export default function LoginPage() {
  return <FeishuLoginClient appId={process.env.FEISHU_APP_ID ?? ""} basePath={BASE_PATH} />;
}
