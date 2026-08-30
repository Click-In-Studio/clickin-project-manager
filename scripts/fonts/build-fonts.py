#!/usr/bin/env python3
"""
剧本字体自托管构建（#336 阶段 B3）。

把四个字体文件按 unicode-range 切片成 woff2，落到 public/fonts/<face>/，并生成
app/fonts.css（每片一条 @font-face）。浏览器只下载页面真正用到的片，首屏不必
等 8MB / 16MB 的整包。

为什么要自托管楷体与歌词字体：`.stage-inline`（行内舞台指示）内嵌在对白块里，
字体不同 → 拉丁字母 / 标点的进宽不同 → 换行点不同 → 块高不同 → 分页不同。
原先楷体走 KaiTi（Win）/ STKaiti（Mac）/ Linux 无，三个平台三种字宽；歌词的
华文中宋是商业字体不能自托管，改用朱雀仿宋（OFL）。

面（CSS font-family 名是我们自己的，与字体内部名无关）：
  SourceHanSerif   台词正文    思源宋体 CN Medium(400-600) / Bold(700-900)
  LXGWWenKai       舞台指示    霞鹜文楷 Regular
  ZhuqueFangsong   歌词        朱雀仿宋 Regular（技术预览版，GB2312 全覆盖；缺字落到 SourceHanSerif）

许可：
  · 霞鹜文楷 OFL-1.1，作者在 RFN 条款外**明确附加许可**「为 web 字体投递而子集化 /
    转 WOFF2 的修改版可继续使用保留名」——可直接切片，不改名。
  · 朱雀仿宋 OFL-1.1，未声明 Reserved Font Name——可直接切片。
  · 思源宋体 OFL-1.1，**有** Reserved Font Name。切片属修改版，故把 name 表里的
    家族名改成「Backstage Serif CN」（版权 / 许可 name 记录原样保留）。CSS 里
    仍叫 SourceHanSerif——那只是我们的 CSS 标识符。

来源与版本钉死在下面的 SOURCES 里（URL + sha256）；思源宋体的两个 woff2 是仓库原有
的自托管文件，挪到 scripts/fonts/src/ 当源（同一 blob，git 里不占新空间）。
其余源文件按需下载到 scripts/fonts/src/（gitignored）。

用法：
  python3 -m pip install fonttools brotli
  python3 scripts/fonts/build-fonts.py          # 增量：源与配置没变就跳过
  python3 scripts/fonts/build-fonts.py --force  # 全部重切

输出是确定性的（不重算时间戳），重跑不产生 diff。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
except ImportError:  # pragma: no cover
    sys.exit("需要 fonttools 与 brotli：python3 -m pip install fonttools brotli")

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "scripts" / "fonts" / "src"
OUT_DIR = ROOT / "public" / "fonts"
CSS_PATH = ROOT / "app" / "fonts.css"
MANIFEST_PATH = OUT_DIR / "manifest.json"

SHS_RENAMED_FAMILY = "Backstage Serif CN"


@dataclass(frozen=True)
class Source:
    path: str                 # 相对 SRC_DIR
    url: str | None = None    # None = 仓库自带
    sha256: str | None = None
    zip_member: str | None = None  # url 指向 zip 时，取其中哪个文件


@dataclass(frozen=True)
class Face:
    out: str            # public/fonts/<out>/
    css_family: str
    css_weight: str
    source: Source
    rename_family: str | None = None
    note: str = ""


SOURCES = {
    "shs-medium": Source(path="SourceHanSerifCN-Medium.woff2"),
    "shs-bold": Source(path="SourceHanSerifCN-Bold.woff2"),
    "lxgw-regular": Source(
        path="LXGWWenKai-Regular.ttf",
        url="https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf",
        sha256="39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009",
    ),
    "zhuque-regular": Source(
        path="ZhuqueFangsong-Regular.ttf",
        url="https://github.com/TrionesType/zhuque/releases/download/v0.212/ZhuqueFangsong-v0.212.zip",
        sha256="558c62730844fe54ba220146ed62f859d4e2880188d92d985f8921c6e3743bc4",
        zip_member="ZhuqueFangsong-Regular.ttf",
    ),
}

FACES = [
    Face("shs-medium", "SourceHanSerif", "400 600", SOURCES["shs-medium"], SHS_RENAMED_FAMILY,
         "思源宋体 CN Medium · 台词正文"),
    Face("shs-bold", "SourceHanSerif", "700 900", SOURCES["shs-bold"], SHS_RENAMED_FAMILY,
         "思源宋体 CN Bold · 角色名 / 加粗"),
    Face("lxgw-regular", "LXGWWenKai", "400", SOURCES["lxgw-regular"], None,
         "霞鹜文楷 Regular v1.522 · 舞台指示（斜体由浏览器合成）"),
    Face("zhuque-regular", "ZhuqueFangsong", "400", SOURCES["zhuque-regular"], None,
         "朱雀仿宋 Regular v0.212 · 歌词（加粗由浏览器合成）"),
]

# 切片：每片一个 unicode 区间。CJK 统一表意文字每 0x400（1024 码位）一片，
# 一片约 75–190KB；其余按 Unicode 块归并。区间只是「可能包含」——某字体在该区间
# 没字形的片会被跳过，不生成 @font-face。
def _chunks(start: int, end: int, step: int) -> list[tuple[int, int]]:
    return [(a, min(a + step - 1, end)) for a in range(start, end + 1, step)]


RANGES: list[tuple[int, int]] = [
    (0x0000, 0x00FF),   # Basic Latin + Latin-1
    (0x0100, 0x2E7F),   # 其余拉丁 / 通用标点（…、—、“”）/ 货币 / 箭头 / 数学
    (0x2E80, 0x33FF),   # CJK 标点、部首、注音、假名、兼容符号
    *_chunks(0x3400, 0x4DBF, 0x0400),   # 扩展 A
    *_chunks(0x4E00, 0x9FFF, 0x0400),   # 统一表意文字
    (0xA000, 0xF8FF),   # 彝文、谚文、私用区（多数字体为空）
    (0xF900, 0xFAFF),   # 兼容表意文字
    (0xFB00, 0xFE2F),
    (0xFE30, 0xFFEF),   # 竖排形式、全角形式
    (0x10000, 0x1FFFF), # 补充平面：符号 / emoji（若有）
    (0x20000, 0x2FFFF), # 扩展 B–F
    (0x30000, 0x3FFFF), # 扩展 G+
]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_source(src: Source) -> Path:
    path = SRC_DIR / src.path
    if path.exists():
        if src.sha256 and sha256_of(path) != src.sha256:
            sys.exit(f"{path} 的 sha256 与钉死的值不符——源文件被换过？删掉重下。")
        return path
    if not src.url:
        sys.exit(f"缺源文件 {path}（仓库自带，不该缺）")
    print(f"下载 {src.url}")
    data = urllib.request.urlopen(src.url).read()  # noqa: S310
    if src.zip_member:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(src.zip_member)
    digest = hashlib.sha256(data).hexdigest()
    if src.sha256 and digest != src.sha256:
        sys.exit(f"下载的 {src.path} sha256={digest}，与钉死的 {src.sha256} 不符")
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def rename_family(font: TTFont, family: str, subfamily: str) -> None:
    """把家族名相关的 name 记录换成我们的名字；版权（0）、许可（13/14）、商标（7）原样。"""
    name = font["name"]
    full = f"{family} {subfamily}".strip()
    ps = full.replace(" ", "")
    for rec in name.names:
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID == 4:
            rec.string = full
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 3:
            rec.string = f"{ps};subset"


def build_face(face: Face, src_path: Path, force: bool, previous: dict) -> list[dict]:
    out_dir = OUT_DIR / face.out
    out_dir.mkdir(parents=True, exist_ok=True)
    base = TTFont(str(src_path), lazy=True)
    cmap = base.getBestCmap()
    # 17 = 排版子族名（Medium / Bold），2 在 RIBBI 模型下只会是 Regular / Bold
    subfamily = base["name"].getDebugName(17) or base["name"].getDebugName(2) or "Regular"
    base.close()
    codepoints = sorted(cmap)
    src_digest = sha256_of(src_path)
    prev_chunks = {c["file"]: c for c in previous.get("chunks", [])} if previous.get("source_sha256") == src_digest else {}
    chunks: list[dict] = []
    for start, end in RANGES:
        present = [cp for cp in codepoints if start <= cp <= end]
        if not present:
            continue
        file_name = f"{start:04x}.woff2"
        out_path = out_dir / file_name
        entry = {"file": file_name, "range": f"U+{start:04X}-{end:04X}", "glyphs": len(present)}
        if not force and out_path.exists() and file_name in prev_chunks:
            entry["bytes"] = out_path.stat().st_size
            chunks.append(entry)
            continue
        options = subset.Options()
        options.flavor = "woff2"
        options.hinting = False
        options.desubroutinize = True
        options.recalc_timestamp = False
        options.name_IDs = ["*"]
        options.name_legacy = True
        options.name_languages = ["*"]
        font = subset.load_font(str(src_path), options)
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=present)
        subsetter.subset(font)
        if face.rename_family:
            rename_family(font, face.rename_family, subfamily)
        subset.save_font(font, str(out_path), options)
        font.close()
        entry["bytes"] = out_path.stat().st_size
        chunks.append(entry)
        print(f"  {face.out}/{file_name}  {len(present):5d} 字  {entry['bytes'] // 1024:4d} KB")
    # 清掉配置里已不存在的旧片
    keep = {c["file"] for c in chunks}
    for stale in out_dir.glob("*.woff2"):
        if stale.name not in keep:
            stale.unlink()
            print(f"  删除过期片 {face.out}/{stale.name}")
    return chunks, src_digest


def write_css(manifest: dict) -> None:
    lines = [
        "/* 由 scripts/fonts/build-fonts.py 生成——不要手改；改配置后重跑脚本。",
        " * 每片一条 @font-face + unicode-range：浏览器只下载页面真正用到的片。",
        " * 面与许可说明见脚本头注。 */",
        "",
    ]
    for face in FACES:
        entry = manifest["faces"][face.out]
        lines.append(f"/* {face.css_family} · {face.note} */")
        for chunk in entry["chunks"]:
            lines.append("@font-face {")
            lines.append(f"  font-family: '{face.css_family}';")
            lines.append(f"  src: url('/fonts/{face.out}/{chunk['file']}') format('woff2');")
            lines.append(f"  font-weight: {face.css_weight};")
            lines.append("  font-style: normal;")
            lines.append("  font-display: swap;")
            lines.append(f"  unicode-range: {chunk['range']};")
            lines.append("}")
        lines.append("")
    CSS_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="忽略缓存，全部重切")
    args = parser.parse_args()

    previous = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {"faces": {}}
    manifest = {"generator": "scripts/fonts/build-fonts.py", "faces": {}}
    for face in FACES:
        src_path = ensure_source(face.source)
        print(f"{face.out}: {src_path.name}")
        chunks, digest = build_face(face, src_path, args.force, previous["faces"].get(face.out, {}))
        manifest["faces"][face.out] = {
            "css_family": face.css_family,
            "css_weight": face.css_weight,
            "note": face.note,
            "source": face.source.path,
            "source_url": face.source.url,
            "source_sha256": digest,
            "renamed_family": face.rename_family,
            "chunks": chunks,
            "bytes": sum(c["bytes"] for c in chunks),
        }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_css(manifest)
    total = sum(f["bytes"] for f in manifest["faces"].values())
    print(f"完成：{sum(len(f['chunks']) for f in manifest['faces'].values())} 片，共 {total / 1024 / 1024:.1f} MB → {CSS_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
