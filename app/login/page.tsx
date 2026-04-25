import { BASE_PATH } from "@/lib/base-path";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100">
      <div className="w-80 rounded-2xl bg-white px-8 py-10 shadow-sm text-center">
        <h1 className="mb-2 text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">
          剧本编辑器
        </h1>
        <p className="mb-8 text-xs text-zinc-300">请使用飞书账号登录以继续</p>
        <a
          href={`${BASE_PATH}/api/auth/login`}
          className="inline-block w-full rounded-lg bg-zinc-800 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
        >
          使用飞书登录
        </a>
      </div>
    </div>
  );
}
