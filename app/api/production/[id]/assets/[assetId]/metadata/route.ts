import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, resolveAssetFile } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import { getOrExtractFileMetadata, hydrateMetadata, extractEnvelope } from "@/lib/asset/metadata";
import { openZipEntrySource } from "@/lib/asset/metadata-parsers";
import { TransientReadError, r2ByteSource } from "@/lib/asset/byte-source";

/**
 * #85 元数据读面：latest file（latest-wins，与 preview/download 同口径）的信封。
 * 懒轨触发点就在这里——首次请求就地分析写回，之后走 DB 缓存（文件行不可变，
 * 信封只在分析器/broker 版本升级时重算）。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  if (!await canViewAsset(access.permCtx, id, asset, "meta"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (asset.storageType !== "r2") return Response.json({ fileId: null, fileSize: null, metadata: null });

  const file = await resolveAssetFile(assetId);
  if (!file) return Response.json({ fileId: null, fileSize: null, metadata: null });

  try {
    let metadata = await getOrExtractFileMetadata(file, asset.fileName);

    // ?entry=<包内路径>：对 zip 内单个 entry 就地跑 broker/分析器（懒算不落盘，
    // 结果按 (fileId, entry, 版本) 不可变靠 HTTP 缓存）。zip 内支持面≠独立支持
    // 面：store 直通 Range、deflate≤8MB 整解压、其余 reason 明确拒绝
    const entryPath = req.nextUrl.searchParams.get("entry");
    if (entryPath != null) {
      if (metadata?.parserKey !== "application/zip")
        return Response.json({ entryPath, metadata: null, reason: "仅支持 zip 包内条目" }, { status: 400 });
      if (!file.r2Key) {
        // zip 信封在而 r2Key 空＝存储不一致，不是客户端问题
        console.error(`[asset-metadata] zip envelope without r2Key (${file.id})`);
        return Response.json({ error: "文件存储状态异常" }, { status: 500 });
      }
      const hydrated = await hydrateMetadata(metadata);
      const entries = hydrated.data?.entries as Record<string, unknown>[] | undefined;
      const e = entries?.find((x) => x.path === entryPath);
      if (!e) return Response.json({ error: "条目不存在" }, { status: 404 });
      const offset = Number(e.offset), method = Number(e.method), compressedBytes = Number(e.compressedBytes);
      if (!Number.isFinite(offset) || !Number.isFinite(method) || !Number.isFinite(compressedBytes))
        return Response.json({ entryPath, metadata: null, reason: "条目索引不完整（旧版本清单）" },
          { headers: { "Cache-Control": "private, max-age=300" } });
      try {
        const es = await openZipEntrySource(r2ByteSource(file.r2Key, file.fileSize), {
          offset, method, compressedBytes,
          uncompressedBytes: typeof e.uncompressedBytes === "number" ? e.uncompressedBytes : null,
          encrypted: e.encrypted === true,
        });
        const entryMeta = await extractEnvelope(es, entryPath.slice(entryPath.lastIndexOf("/") + 1));
        return Response.json(
          { entryPath, metadata: entryMeta },
          { headers: { "Cache-Control": "private, max-age=300" } },
        );
      } catch (err) {
        if (err instanceof TransientReadError) throw err; // 交给外层降级/瞬态语义
        // 确定性拒绝走白名单文案；其余（zlib 内部错误等）不把原始 message 漏给
        // 客户端，收敛为通用文案 + 服务端日志
        const msg = err instanceof Error ? err.message : String(err);
        const reason = msg.includes("encrypted") ? "条目已加密，无法解析"
          : msg.includes("too large") ? "条目过大，需完整解压，暂不支持"
          : msg.includes("compression method") ? "不支持的压缩算法"
          : msg.includes("local header") ? "条目数据损坏"
          : "无法解析该条目";
        if (reason === "无法解析该条目") console.warn(`[asset-metadata] entry parse failed (${file.id} ${entryPath}):`, err);
        return Response.json(
          { entryPath, metadata: null, reason },
          { headers: { "Cache-Control": "private, max-age=300" } },
        );
      }
    }
    // ?full=1：清单落了 sidecar 的（大档案）拉回 entries 拼进响应
    if (metadata && req.nextUrl.searchParams.get("full") === "1") {
      try {
        metadata = await hydrateMetadata(metadata);
      } catch (e) {
        console.warn(`[asset-metadata] sidecar hydrate failed (${file.id}):`, e);
      }
    }
    // 内容按 (fileId, parserVersion) 基本不可变，唯一变化通道是版本 bump 重算
    // ⇒ private 短缓存挡重复打开；鉴权响应必须 private
    return Response.json(
      { fileId: file.id, fileSize: file.fileSize, metadata },
      // no-cache：URL 不携带 parserVersion，长缓存会在版本 bump/热修后让客户端端着
      // 陈旧数据最长一小时（2026-09-06 乱码热修后线上实锤，Tauri/WKWebView 硬刷新也不回源）
      { headers: { "Cache-Control": "private, no-cache" } },
    );
  } catch (e) {
    // 只降级瞬态读失败（R2 网络类）：回旧信封/空，不落盘，下次请求重试
    // （avatar-serve 同款「显示不空窗」）。其余异常是管线 bug——确定性失败
    // 本应在 getOrExtractFileMetadata 内落成 failed 信封返回，到得了这里的
    // 一律 500 暴露出来，不许静默降级把 bug 埋掉（UI 对非 2xx 自会不显示）。
    if (e instanceof TransientReadError) {
      console.warn(`[asset-metadata] transient read failed (${file.id}):`, e);
      return Response.json({ fileId: file.id, fileSize: file.fileSize, metadata: file.metadata });
    }
    console.error(`[asset-metadata] pipeline error (${file.id}):`, e);
    return Response.json({ error: "元数据分析失败" }, { status: 500 });
  }
}
