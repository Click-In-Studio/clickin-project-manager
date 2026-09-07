// 解析 IR 的持久化（R2）：worker 解析一次，所有进程按键取用。
//
// 进程内 LRU（load.ts）在 pm2 重启即失效、且不跨进程——IR 落 R2 后：
// - agent-runner 读文档不再自己解析（600M 内存预算里跑 50MB pdfjs 是 OOM 元凶）；
// - 重启/多进程/未来集群 worker 共享同一份产物；
// - 文件行不可变 ⇒ fileId 即键；解析器升级靠版本号进键名自然失效旧产物。

import { gzipSync, gunzipSync } from "node:zlib";
import { getR2Object, putR2Object } from "@/lib/r2";

export type DocKind = "pdf" | "docx";

export function docIrR2Key(kind: DocKind, fileId: string, version: number): string {
  return `doc-ir/${fileId}.${kind}.v${version}.json.gz`;
}

export async function storeDocIr(kind: DocKind, fileId: string, version: number, doc: unknown): Promise<string> {
  const key = docIrR2Key(kind, fileId, version);
  await putR2Object(key, gzipSync(Buffer.from(JSON.stringify(doc), "utf8")), "application/gzip");
  return key;
}

export async function loadDocIr<T>(kind: DocKind, fileId: string, version: number): Promise<T | null> {
  const obj = await getR2Object(docIrR2Key(kind, fileId, version));
  if (!obj) return null;
  try {
    return JSON.parse(gunzipSync(obj.body).toString("utf8")) as T;
  } catch {
    return null; // 残缺产物当缺失：走重新解析
  }
}
