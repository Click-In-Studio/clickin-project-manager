import type { Metadata } from "next";
import AgentChatClient from "@/components/AgentChatClient";

export const metadata: Metadata = { title: "AI 助手" };

// Auth is enforced by proxy.ts (redirects to /login) and again by every
// /api/agent/* route — this page itself renders no user-specific data.
export default function AgentPage() {
  return <AgentChatClient />;
}
