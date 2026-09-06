/**
 * 压缩包清单的展示层纯函数（#85）：系统垃圾识别 + 树形组装。
 * 放 lib 而非组件内是为了可测（macOS zip 的垃圾形态是重灾区）。
 */

export interface ArchiveViewEntry {
  path: string;
  uncompressedBytes?: number | null;
  isDirectory?: boolean;
  encrypted?: boolean;
}

export interface ArchiveTreeNode<E extends ArchiveViewEntry = ArchiveViewEntry> {
  name: string;
  /** 树内全路径（不带尾斜杠）。 */
  path: string;
  isDir: boolean;
  /** 文件=自身尺寸；目录=后代聚合（未知尺寸的后代按 0 计）。 */
  sizeBytes: number;
  entry?: E;
  children: ArchiveTreeNode<E>[];
}

/**
 * macOS 打包垃圾（__MACOSX/ 全树、.DS_Store、._AppleDouble）+ Windows 常客。
 * 默认隐藏是**展示层**行为：数据层清单保持完整诚实（entryCount 不变），
 * 引用 join 也不受影响（._ 前缀天然对不上）。
 */
export function isSystemJunkPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === "__MACOSX" || norm.startsWith("__MACOSX/")) return true;
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini" || base.startsWith("._");
}

/**
 * 从平铺 entry 表组树。文件夹从路径段推导（zip 不保证有显式目录 entry），
 * 显式目录 entry 只用来补空文件夹。目录在前、各按名排序。
 */
export function buildArchiveTree<E extends ArchiveViewEntry>(
  entries: E[],
  opts?: { hideJunk?: boolean },
): { roots: ArchiveTreeNode<E>[]; hiddenCount: number; visibleFileCount: number } {
  const hideJunk = opts?.hideJunk ?? true;
  type Node = ArchiveTreeNode<E> & { childMap: Map<string, Node> };
  const rootMap = new Map<string, Node>();
  let hiddenCount = 0;
  let visibleFileCount = 0;

  const ensureDir = (segs: string[]): Map<string, Node> => {
    let map = rootMap;
    let prefix = "";
    for (const seg of segs) {
      prefix = prefix === "" ? seg : `${prefix}/${seg}`;
      let node = map.get(seg);
      if (!node) {
        node = { name: seg, path: prefix, isDir: true, sizeBytes: 0, children: [], childMap: new Map() };
        map.set(seg, node);
      }
      map = node.childMap;
    }
    return map;
  };

  for (const e of entries) {
    if (hideJunk && isSystemJunkPath(e.path)) { hiddenCount += 1; continue; }
    const norm = e.path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm === "") continue;
    const segs = norm.split("/").filter((s) => s !== "");
    if (e.isDirectory) {
      ensureDir(segs);
      continue;
    }
    const dirMap = ensureDir(segs.slice(0, -1));
    const name = segs[segs.length - 1];
    // 同名重复 entry（zip 允许）后者覆盖前者，与解压器 latest-wins 行为一致
    dirMap.set(name, {
      name, path: norm, isDir: false,
      sizeBytes: e.uncompressedBytes ?? 0, entry: e, children: [], childMap: new Map(),
    });
    visibleFileCount += 1;
  }

  const finalize = (map: Map<string, Node>): ArchiveTreeNode<E>[] => {
    const nodes = [...map.values()];
    for (const n of nodes) {
      if (n.isDir) {
        n.children = finalize(n.childMap);
        n.sizeBytes = n.children.reduce((s, c) => s + c.sizeBytes, 0);
      }
      delete (n as Partial<Node>).childMap;
    }
    nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1));
    return nodes;
  };
  return { roots: finalize(rootMap), hiddenCount, visibleFileCount };
}

/** 树 → 可见行（受折叠状态控制），渲染层直接 map。 */
export function flattenTree<E extends ArchiveViewEntry>(
  roots: ArchiveTreeNode<E>[],
  expanded: ReadonlySet<string>,
): { node: ArchiveTreeNode<E>; depth: number }[] {
  const out: { node: ArchiveTreeNode<E>; depth: number }[] = [];
  const walk = (nodes: ArchiveTreeNode<E>[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.isDir && expanded.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** 收集全部目录路径（默认展开态用）。 */
export function allDirPaths(roots: ArchiveTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: ArchiveTreeNode[]) => {
    for (const n of nodes) if (n.isDir) { out.push(n.path); walk(n.children); }
  };
  walk(roots);
  return out;
}
