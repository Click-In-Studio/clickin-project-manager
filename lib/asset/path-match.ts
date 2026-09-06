/**
 * 相对引用的路径匹配器（#85 PR3）。zip 包内链接 / 未来文件夹活算 / QC 比对
 * 共用一份，全纯函数。
 *
 * join 判据必须归一化，否则大面积假阴性：
 * - 分隔符：Windows 工程写 `\`；
 * - `.`/`..` 折叠：工程引用常见 `../samples/x.wav`；
 * - 大小写：macOS 文件系统默认不敏感，工程里引用的大小写经常和实际文件对不上；
 * - Unicode NFD：macOS 把中文/带音标文件名存成分解形式，zip 里和别处的同一个
 *   名字字节不同——用户全在 Mac 上 + 文件名大量中文，这条是主力坑。
 */

/** 语法归一：分隔符统一 `/`、折叠 `.`/`..`、去首尾冗余。不动大小写与 Unicode 形式。 */
export function normalizePath(p: string): string {
  const segs: string[] = [];
  for (const raw of p.replace(/\\/g, "/").split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      // 越出根的 `..` 保留（信息不丢，匹配自然失败），不吞成根
      if (segs.length > 0 && segs[segs.length - 1] !== "..") segs.pop();
      else segs.push("..");
    } else {
      segs.push(raw);
    }
  }
  return segs.join("/");
}

/** 匹配键：语法归一 + NFC + 全小写。只用于 join，展示用原始值。 */
export function pathMatchKey(p: string): string {
  return normalizePath(p).normalize("NFC").toLowerCase();
}

/** 以 baseDir（引用发起文件所在目录）解析相对引用；绝对路径原样归一。 */
export function resolveRef(baseDir: string, ref: string): string {
  const r = ref.replace(/\\/g, "/");
  if (r.startsWith("/")) return normalizePath(r);
  return normalizePath(baseDir === "" ? r : `${baseDir}/${r}`);
}

/** 路径的目录部分（归一后）。 */
export function dirOf(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
}

/**
 * 把一组相对引用对着命名空间（如 zip 的 entry 表）做 join。
 * 返回每条引用是否命中；命名空间键在此统一过 pathMatchKey。
 */
export function matchRefs(
  refs: { path: string }[],
  namespacePaths: string[],
  baseDir = "",
): { path: string; resolved: boolean }[] {
  const ns = new Set(namespacePaths.map(pathMatchKey));
  return refs.map((r) => ({
    path: r.path,
    resolved: ns.has(pathMatchKey(resolveRef(baseDir, r.path))),
  }));
}
