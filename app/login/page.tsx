import type { Metadata } from "next";
import LoginClient from "./LoginClient";

export const metadata: Metadata = { title: "登录 / 注册" };

export default function LoginPage() {
  return (
    <LoginClient
      inviteOnly={process.env.REGISTRATION_INVITE_ONLY === "1" || process.env.REGISTRATION_INVITE_ONLY === "true"}
    />
  );
}
