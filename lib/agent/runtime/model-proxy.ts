import { fetch as undiciFetch, ProxyAgent } from "undici";

// 每个显式代理地址复用连接池；只由模型配置入口选择，不改全局 fetch 或 dispatcher。
const fetchers = new Map<string, typeof fetch>();

export function modelProxyFetch(proxyUrl: string): typeof fetch {
  const existing = fetchers.get(proxyUrl);
  if (existing) return existing;
  const dispatcher = new ProxyAgent(proxyUrl);
  const fetcher: typeof fetch = (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init as Parameters<typeof undiciFetch>[1],
      dispatcher,
    }) as unknown as Promise<Response>;
  fetchers.set(proxyUrl, fetcher);
  return fetcher;
}
