// MMP media_id 是内容 hash，只能在宿主完成附件归属或资产权限校验后作为内部缓存引用使用。
// 文件行不可变，因此以 fileId 记进程内 LRU；进程重启只会多下载一次，不影响正确性。

import { media, type MediaHandle } from "@mmp/client";

const MEDIA_ID_CAP = 500;
const mediaIdByFile = new Map<string, string>();

export function mmpMediaHandle(fileId: string, source: MediaHandle): MediaHandle {
  const known = mediaIdByFile.get(fileId);
  return known ? media.refOr(known, source) : source;
}

export function rememberMmpMediaId(fileId: string, mediaId: string): void {
  mediaIdByFile.delete(fileId);
  mediaIdByFile.set(fileId, mediaId);
  while (mediaIdByFile.size > MEDIA_ID_CAP) mediaIdByFile.delete(mediaIdByFile.keys().next().value!);
}

export function clearMmpMediaCacheForTests(): void {
  mediaIdByFile.clear();
}
