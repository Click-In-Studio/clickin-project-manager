// ─── 粘贴 HTML 的 img 收口（嵌入语法收敛轮）────────────────────────────────────
//
// 正文只存 asset id 不存 URL。外部网页粘贴携带的 <img src="https://…"> 若放行，
// WikiImage.parseHTML（认任意 img[src]）会把它收编成 image 节点、落库成
// ![](https://…)——不落引用边、不受权限约束、URL 会过期，三重纪律全绕过。
// 此前只有飞书来源被 feishu-paste 拦截；这里把口子收齐：
//   · 私有形态（data-cm-src / src=/__cm__…）放行——编辑器自身复制回流
//   · 本站 thumb/preview 端点 URL 反解出 assetId → 还原成私有形态（从只读
//     渲染面复制正文再贴回编辑器的场景）
//   · 其余 http(s) 外链 → 降级为链接文字（信息不丢，但不冒充嵌入）
//   · data:/blob: 内嵌图 → 降级为占位文字（无处可链；转存管线属长尾）

const ASSET_ENDPOINT_RE = /\/api\/production\/[^/]+\/assets\/([^/?#]+)\/(?:thumb|preview-url)(?:[?#]|$)/;

export function stripExternalPastedImages(html: string): string {
  if (!/<img/i.test(html)) return html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html; // 解析不了就原样放行——宁可少收口不拦粘贴（与飞书归一化同则）
  }
  let changed = false;
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (img.getAttribute("data-cm-src") || src.startsWith("/__cm__")) continue;

    const endpoint = ASSET_ENDPOINT_RE.exec(src);
    if (endpoint) {
      img.setAttribute("data-cm-src", `/__cm__/asset/${endpoint[1]}`);
      changed = true;
      continue;
    }

    const alt = img.getAttribute("alt")?.trim() ?? "";
    if (/^https?:\/\//i.test(src)) {
      const a = doc.createElement("a");
      a.setAttribute("href", src);
      a.textContent = alt ? `[图片：${alt}]` : "[图片]";
      img.replaceWith(a);
    } else {
      // data:/blob:/相对路径等：没有可持久指向的目标
      img.replaceWith(doc.createTextNode(alt ? `[图片：${alt}]` : "[图片：未导入]"));
    }
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
