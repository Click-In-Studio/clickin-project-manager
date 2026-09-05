import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { filterVisibleAssets } from "@/lib/asset/perm";
import { hasGrant } from "@/lib/grant-check";
import { createAsset, listAssets, type AssetType } from "@/lib/asset/db";
import { canPlaceNodeUnder, canWriteNodeContainer } from "@/lib/node/perm";
import { toActor } from "@/lib/grant-check";
import { isAssetType } from "@/lib/asset/types";
import { putR2Object, getR2Object, thumbnailR2Key, completeMultipartUpload, listMultipartParts } from "@/lib/r2";
import sharp from "sharp";
import { getPool } from "@/lib/pg";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const assets = await listAssets(id);
  // 批D：可见性过滤（能力票∧结构 ∨ publication@view）
  const visible = await filterVisibleAssets(access.permCtx, id, assets);
  // #420：附带壳节点树面（nodeId + listable=「共享资产」面板数据源，原 production
  // mount 语义）。一次集合查询，避免 N+1。
  const { rows } = await getPool().query<{ asset_id: string; id: string; listable: boolean }>(
    `SELECT asset_id, id, listable FROM node WHERE production_id = $1 AND asset_id IS NOT NULL`,
    [id],
  );
  const nodeByAsset = new Map(rows.map(r => [r.asset_id, r]));
  return Response.json({
    assets: visible.map(a => ({
      ...a,
      nodeId: nodeByAsset.get(a.id)?.id ?? null,
      listable: nodeByAsset.get(a.id)?.listable ?? false,
    })),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });
  // 批D：上传 = asset/*@create（原为裸门，按名义键收紧，与批A GET 补门先例一致）
  if (!session.isAdmin && !access.permCtx.isOwner && !await hasGrant(session.userId, id, "asset", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const ct = req.headers.get("content-type") ?? "";

  // ── JSON body: feishu link OR pre-uploaded R2 registration ─────────────────
  if (ct.includes("application/json")) {
    const body = (await req.json()) as {
      storageType: "feishu_link" | "r2" | "r2-multipart";
      // feishu fields
      feishuUrl?: string;
      // r2 pre-upload fields
      r2Key?: string;
      fileId?: string;
      mimeType?: string;
      fileSize?: number;
      // r2-multipart extra fields
      uploadId?: string;
      parts?: { partNumber: number; eTag: string }[];
      // shared
      assetType: AssetType;
      name?: string | null;
      fileName: string;
      /** 壳节点落点（node id，#420 第二批）。缺省＝「资产」根（懒建，行为不变）。 */
      parentNodeId?: string | null;
      /** 树可枚举性。缺省 false（私有）。上传即共享是「新建自己的资产」，门按
       *  wiki 先例走 create + 落位双门；共享**已有**资产仍走 node 路由的
       *  publication∧mounts 门，此处不构成旁路（只能共享自己刚建的）。 */
      listable?: boolean;
    };

    // 指定落点 → 落位双门（与 wiki POST 同门：无权移入就不许在此新建）
    const parentNodeId = body.parentNodeId?.trim() || null;
    if (parentNodeId) {
      const actor = toActor(session, access.permCtx);
      if (!await canPlaceNodeUnder(actor, id, parentNodeId))
        return Response.json({ error: "无权在该位置创建" }, { status: 403 });
      if (!await canWriteNodeContainer(actor, id, parentNodeId))
        return Response.json({ error: "无权修改该容器的子目录" }, { status: 403 });
    }
    const listable = body.listable === true;

    // asset_type 列无 CHECK 约束，白名单只在 TS 层——运行时校验防任意串入库
    if (body.assetType !== undefined && !isAssetType(body.assetType))
      return Response.json({ error: "无效的资产类型" }, { status: 400 });

    if (body.storageType === "r2-multipart") {
      if (!body.r2Key || !body.fileId || !body.fileName || !body.uploadId || !Array.isArray(body.parts))
        return Response.json({ error: "缺少 r2Key / fileId / fileName / uploadId / parts" }, { status: 400 });

      // Fetch real ETags server-side — client-provided ETags are unreliable because
      // R2 CORS does not expose the ETag response header to browsers.
      const parts = await listMultipartParts(body.r2Key, body.uploadId);
      await completeMultipartUpload(body.r2Key, body.uploadId, parts);

      const mimeType = body.mimeType ?? "application/octet-stream";
      let thumbKey: string | null = null;
      if (mimeType.startsWith("image/")) {
        const obj = await getR2Object(body.r2Key);
        if (obj) {
          const thumb = await sharp(obj.body)
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          thumbKey = thumbnailR2Key(body.fileId);
          await putR2Object(thumbKey, thumb, "image/webp");
        }
      }

      const { asset, file } = await createAsset({
        productionId: id, uploaderUserId: session.userId,
        assetType: body.assetType ?? "reference", name: body.name ?? null,
        fileName: body.fileName, mimeType,
        storageType: "r2", r2Key: body.r2Key, thumbnailR2Key: thumbKey,
        fileSize: body.fileSize ?? null,
        nodeParentId: parentNodeId, listable,
      });
      return Response.json({ asset, file }, { status: 201 });
    }

    if (body.storageType === "r2") {
      if (!body.r2Key || !body.fileId || !body.fileName)
        return Response.json({ error: "缺少 r2Key / fileId / fileName" }, { status: 400 });

      const mimeType = body.mimeType ?? "application/octet-stream";
      let thumbKey: string | null = null;
      if (mimeType.startsWith("image/")) {
        const obj = await getR2Object(body.r2Key);
        if (obj) {
          const thumb = await sharp(obj.body)
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          thumbKey = thumbnailR2Key(body.fileId);
          await putR2Object(thumbKey, thumb, "image/webp");
        }
      }

      const { asset, file } = await createAsset({
        productionId: id, uploaderUserId: session.userId,
        assetType: body.assetType ?? "reference", name: body.name ?? null,
        fileName: body.fileName, mimeType,
        storageType: "r2", r2Key: body.r2Key, thumbnailR2Key: thumbKey,
        fileSize: body.fileSize ?? null,
        nodeParentId: parentNodeId, listable,
      });
      return Response.json({ asset, file }, { status: 201 });
    }

    // feishu_link
    if (!body.feishuUrl || !body.fileName)
      return Response.json({ error: "缺少 feishuUrl 或 fileName" }, { status: 400 });

    const { asset, file } = await createAsset({
      productionId: id, uploaderUserId: session.userId,
      assetType: body.assetType ?? "reference", name: body.name ?? null,
      fileName: body.fileName, mimeType: null,
      storageType: "feishu_link", feishuUrl: body.feishuUrl,
      nodeParentId: parentNodeId, listable,
    });
    return Response.json({ asset, file }, { status: 201 });
  }

  return Response.json({ error: "不支持的 Content-Type" }, { status: 415 });
}
