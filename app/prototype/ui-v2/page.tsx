import type { Metadata } from "next";
import PrototypeClient from "./PrototypeClient";

export const metadata: Metadata = {
  title: "UI / UX 产品框架演示",
  description: "剧组 SaaS 产品信息架构与关键交互示意",
};

export default function UiV2PrototypePage() {
  return <PrototypeClient />;
}
