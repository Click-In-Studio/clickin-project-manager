import { describe, it, expect } from "vitest";
import { gzipSync, deflateRawSync } from "zlib";
import { extractEnvelope } from "@/lib/asset/metadata";
import { sniffDetectedType, BROKER_VERSION } from "@/lib/asset/metadata-broker";
import { parseAlsXml, parseQlabWorkspace, openZipEntrySource, ZIP_ENTRY_INFLATE_CAP } from "@/lib/asset/metadata-parsers";
import { parseBplist, mget, BplistUID } from "@/lib/asset/bplist";
import { normalizePath, pathMatchKey, resolveRef, dirOf, matchRefs } from "@/lib/asset/path-match";
import { bufferByteSource } from "@/lib/asset/byte-source";

// #85 PR3：路径匹配器 / als / qlab（双层 bplist）/ zip 包内工程递归。
// 真实工程文件含用户真实路径不入库；fixture 全部合成（含测试用 bplist writer）。
// als/qlab 解析器已另对 /Volumes/WD4TB/Drama 的真实 qlab4/qlab5/als 工程验证过。

// ─── 路径匹配器 ──────────────────────────────────────────────────────────────

describe("path-match", () => {
  it("归一：分隔符/./..（越根的 .. 保留不吞）", () => {
    expect(normalizePath("a\\b\\..\\c/./d")).toBe("a/c/d");
    expect(normalizePath("../x/y")).toBe("../x/y");
    expect(normalizePath("a/../../x")).toBe("../x");
  });

  it("匹配键：大小写 + macOS NFD 归一（注意：纯汉字 NFD 稳定，分解的是变音符/假名/谚文）", () => {
    const nfc = "音乐/première-ガ.wav"; // é 与 ガ 都会被 NFD 拆成基字+组合符
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc); // 前提成立：两种形式字节确实不同
    expect(pathMatchKey(nfd)).toBe(pathMatchKey(nfc));
    expect(pathMatchKey("Audio/MAIN.WAV")).toBe(pathMatchKey("audio/main.wav"));
  });

  it("resolveRef 以发起文件目录为基", () => {
    expect(resolveRef("show", "Samples/a.wav")).toBe("show/Samples/a.wav");
    expect(resolveRef("show/sub", "../a.wav")).toBe("show/a.wav");
    expect(resolveRef("show", "/abs/a.wav")).toBe("abs/a.wav");
    expect(dirOf("a/b/c.als")).toBe("a/b");
  });

  it("matchRefs 对命名空间 join", () => {
    const out = matchRefs(
      [{ path: "Samples/开场曲.wav" }, { path: "missing.wav" }],
      ["Proj/Samples/开场曲.wav".normalize("NFD")],
      "Proj",
    );
    expect(out).toEqual([
      { path: "Samples/开场曲.wav", resolved: true },
      { path: "missing.wav", resolved: false },
    ]);
  });
});

// ─── als ─────────────────────────────────────────────────────────────────────

const ALS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" Creator="Ableton Live 12.3.5">
<LiveSet><Tracks>
<GroupTrack Id="20"><Name><EffectiveName Value="&#38899;&#25928;&#32452;" /></Name><TrackGroupId Value="-1" /></GroupTrack>
<AudioTrack Id="8"><Name><EffectiveName Value="Vocals &amp; FX" /></Name><TrackGroupId Value="20" />
  <SampleRef><FileRef><RelativePathType Value="3" /><RelativePath Value="Samples/Recorded/take1.aif" /><Path Value="/Users/x/Proj/Samples/Recorded/take1.aif" /></FileRef></SampleRef>
</AudioTrack>
<MidiTrack Id="12"><Name><EffectiveName Value="Keys" /></Name><TrackGroupId Value="-1" />
  <FileRef><RelativePathType Value="5" /><RelativePath Value="Devices/Delay/Preset.adv" /><Path Value="/Users/x/Library/Preset.adv" /></FileRef>
</MidiTrack>
</Tracks></LiveSet></Ableton>`;

describe("alsParser", () => {
  it("track 结构（type/name/分组）+ 引用 scope 判定 + 实体解码", () => {
    const d = parseAlsXml(ALS_XML);
    expect(d).toMatchObject({ creator: "Ableton Live 12.3.5", trackCount: 3, refCount: 2, projectRefCount: 1 });
    expect(d.tracks).toEqual([
      { id: 20, type: "GroupTrack", name: "音效组", groupId: null },
      { id: 8, type: "AudioTrack", name: "Vocals & FX", groupId: 20 },
      { id: 12, type: "MidiTrack", name: "Keys", groupId: null },
    ]);
    const refs = d.refs as { path: string; scope: string }[];
    expect(refs[0]).toMatchObject({ path: "Samples/Recorded/take1.aif", scope: "project" });
    expect(refs[1].scope).toBe("external"); // RelativePathType=5（库）
  });

  it("实体单趟解码：&#38;amp; 得 '&amp;' 不二次解码", () => {
    const xml = ALS_XML.replace('Value="Keys"', 'Value="A &#38;amp; B &#x26;lt;"');
    const d = parseAlsXml(xml);
    const keys = (d.tracks as { name: string }[])[2];
    expect(keys.name).toBe("A &amp; B &lt;");
  });

  it("track 超帽截断如实标 truncated", () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      `<AudioTrack Id="${i}"><Name><EffectiveName Value="T${i}" /></Name><TrackGroupId Value="-1" /></AudioTrack>`).join("");
    const d = parseAlsXml(`<Ableton Creator="Live"><Tracks>${many}</Tracks></Ableton>`);
    expect(d.trackCount).toBe(500);
    expect(d.truncated).toBe(true);
  });

  it("端到端：gzip 字节 + .als 扩展名 → 破同门命中 als 分析器", async () => {
    const gz = gzipSync(Buffer.from(ALS_XML));
    expect(sniffDetectedType(gz, "show.als")).toBe("application/vnd.ableton.live-set");
    expect(sniffDetectedType(gz, "generic.gz")).toBe("application/gzip");
    const env = await extractEnvelope(bufferByteSource(gz), "show.als");
    expect(env.status).toBe("ok");
    expect(env.data).toMatchObject({ trackCount: 3, projectRefCount: 1 });
  });
});

// ─── 测试用最小 bplist writer（只支撑 qlab fixture 所需类型）─────────────────

type WVal = null | number | string | Buffer | BplistUID | WVal[] | Map<string, WVal>;

function writeBplist(top: WVal): Buffer {
  const objs: WVal[] = [];
  const idOf = new Map<WVal, number>();
  const intern = (v: WVal): number => {
    if (idOf.has(v)) return idOf.get(v)!;
    const id = objs.length;
    objs.push(v);
    idOf.set(v, id);
    if (Array.isArray(v)) v.forEach(intern);
    else if (v instanceof Map) { for (const [k, vv] of v) { intern(k); intern(vv); } }
    return id;
  };
  intern(top);
  const refSize = 2, offSize = 4;
  const chunks: Buffer[] = [Buffer.from("bplist00", "latin1")];
  const offsets: number[] = [];
  let pos = 8;
  const lenByte = (marker: number, len: number): Buffer => {
    if (len < 15) return Buffer.from([marker | len]);
    const b = Buffer.alloc(1 + 1 + 4);
    b[0] = marker | 0x0f; b[1] = 0x12; b.writeUInt32BE(len, 2);
    return b;
  };
  const ref = (v: WVal): Buffer => { const b = Buffer.alloc(refSize); b.writeUInt16BE(idOf.get(v)!, 0); return b; };
  for (const o of objs) {
    offsets.push(pos);
    let out: Buffer;
    if (o === null) out = Buffer.from([0x00]);
    else if (typeof o === "number") { const b = Buffer.alloc(1 + 8); b[0] = 0x13; b.writeBigUInt64BE(BigInt(o), 1); out = b; }
    else if (o instanceof BplistUID) { const b = Buffer.alloc(1 + 2); b[0] = 0x81; b.writeUInt16BE(o.id, 1); out = b; }
    else if (typeof o === "string") {
      const ascii = [...o].every((c) => c.charCodeAt(0) < 128);
      if (ascii) out = Buffer.concat([lenByte(0x50, o.length), Buffer.from(o, "latin1")]);
      else {
        const u16 = Buffer.from(o, "utf16le").swap16();
        out = Buffer.concat([lenByte(0x60, o.length), u16]);
      }
    } else if (Buffer.isBuffer(o)) out = Buffer.concat([lenByte(0x40, o.length), o]);
    else if (Array.isArray(o)) out = Buffer.concat([lenByte(0xa0, o.length), ...o.map(ref)]);
    else { // Map
      const ks = [...o.keys()], vs = [...o.values()];
      out = Buffer.concat([lenByte(0xd0, ks.length), ...ks.map(ref), ...vs.map(ref)]);
    }
    chunks.push(out);
    pos += out.length;
  }
  const table = Buffer.alloc(objs.length * offSize);
  offsets.forEach((off, i) => table.writeUInt32BE(off, i * offSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize; trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objs.length), 8);
  trailer.writeBigUInt64BE(BigInt(idOf.get(top)!), 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([...chunks, table, trailer]);
}

const M = (o: Record<string, WVal>) => new Map(Object.entries(o));

/** 合成 qlab 工作区：双层 bplist + keyed archive（cue 树 + 两路引用形态）。 */
function makeQlabFixture(): Buffer {
  const cls = (name: string) => M({ $classname: name, $classes: [name, "NSObject"] });
  const cGroup = cls("GroupCue"), cAudio = cls("AudioCue"), cAlias = cls("F53Alias"), cMS = cls("NSMutableString");
  // qlab5 形态：F53Alias 带 relativePath
  const alias = M({ $class: new BplistUID(0), lastKnownPath: "/Users/x/Show/audio/开场曲.wav", relativePath: "audio/开场曲.wav" });
  // qlab4 形态：cue 自带 relativePath（NSMutableString 包裹）
  const rel4 = M({ $class: new BplistUID(0), "NS.string": "HG Files/tension.wav" });
  const cue1 = M({ $class: new BplistUID(0), name: "开场曲", number: "1", relativePath: new BplistUID(0) });
  const cue2 = M({ $class: new BplistUID(0), name: "内层组", number: "2", cues: new BplistUID(0) });
  const cue3 = M({ $class: new BplistUID(0), name: "嵌套音频", number: "2.1" });
  const list = M({ $class: new BplistUID(0), name: "Main Cue List", number: "", cues: new BplistUID(0) });
  const root = M({ $class: new BplistUID(0), cues: new BplistUID(0) });
  const nsarr = (items: BplistUID[]) => M({ "NS.objects": items });
  // $objects 平铺 + 手工回填 UID（下标即身份）
  const $objects: WVal[] = [
    "$null",          // 0
    root,             // 1
    cGroup,           // 2
    nsarr([new BplistUID(4)]),                       // 3: root.cues → [list]
    list,             // 4
    nsarr([new BplistUID(6), new BplistUID(8)]),     // 5: list.cues → [cue1, cue2]
    cue1,             // 6
    cAudio,           // 7
    cue2,             // 8
    nsarr([new BplistUID(10)]),                      // 9: cue2.cues → [cue3]
    cue3,             // 10
    alias,            // 11
    cAlias,           // 12
    rel4,             // 13
    cMS,              // 14
  ];
  root.set("$class", new BplistUID(2)); root.set("cues", new BplistUID(3));
  list.set("$class", new BplistUID(2)); list.set("cues", new BplistUID(5));
  cue1.set("$class", new BplistUID(7)); cue1.set("relativePath", new BplistUID(13));
  cue2.set("$class", new BplistUID(2)); cue2.set("cues", new BplistUID(9));
  cue3.set("$class", new BplistUID(7));
  alias.set("$class", new BplistUID(12));
  rel4.set("$class", new BplistUID(14));
  const inner = writeBplist(M({
    $version: 100000, $archiver: "NSKeyedArchiver",
    $top: M({ root: new BplistUID(1) }), $objects,
  }));
  return writeBplist(M({ data: inner })); // 外层薄壳：最大 bplist00 blob 即内层
}

describe("qlabParser", () => {
  it("cue 树（嵌套/编号/中文名）+ 两路引用形态（F53Alias 与 cue.relativePath）", () => {
    const d = parseQlabWorkspace(makeQlabFixture());
    expect(d).toMatchObject({ cueListCount: 1, cueCount: 4, projectRefCount: 2 });
    const lists = d.cueLists as { name?: string; cues?: unknown[] }[];
    expect(lists[0].name).toBe("Main Cue List");
    const l = lists[0].cues as { type: string; number?: string; name?: string; cues?: unknown[] }[];
    expect(l[0]).toMatchObject({ type: "AudioCue", number: "1", name: "开场曲" });
    expect(l[1].cues).toHaveLength(1);
    const refs = d.refs as { path: string; scope: string }[];
    expect(refs.map((r) => r.path).sort()).toEqual(["HG Files/tension.wav", "audio/开场曲.wav"]);
    expect(refs.every((r) => r.scope === "project")).toBe(true);
  });

  it("端到端：bplist 字节 + 扩展名破同门（qlab4/qlab5/裸 plist 三分）", async () => {
    const buf = makeQlabFixture();
    expect(sniffDetectedType(buf, "show.qlab5")).toBe("application/x-qlab5-workspace");
    expect(sniffDetectedType(buf, "show.qlab4")).toBe("application/x-qlab4-workspace");
    expect(sniffDetectedType(buf, "settings.plist")).toBe("application/x-apple-bplist");
    const env = await extractEnvelope(bufferByteSource(buf), "show.qlab5");
    expect(env.status).toBe("ok");
    expect(env.parserKey).toBe("qlab-workspace");
    expect(env.data).toMatchObject({ cueCount: 4 });
  });
});

describe("bplist 读取器", () => {
  it("类型往返：utf16 中文/data/UID/嵌套容器", () => {
    const buf = writeBplist(M({ 中文键: "值：分解形式ǹ", n: 42, d: Buffer.from([1, 2, 3]), u: new BplistUID(7), a: ["x", "y"] }));
    const { top } = parseBplist(buf);
    expect(mget(top, "中文键")).toBe("值：分解形式ǹ");
    expect(mget(top, "n")).toBe(42);
    expect(Buffer.from(mget(top, "d") as Buffer)).toEqual(Buffer.from([1, 2, 3]));
    expect((mget(top, "u") as BplistUID).id).toBe(7);
    expect(mget(top, "a")).toEqual(["x", "y"]);
  });

  it("坏输入确定性抛错（magic/trailer 越界）", () => {
    expect(() => parseBplist(Buffer.from("not a plist at all............................"))).toThrow();
    const b = writeBplist(M({ a: "b" }));
    b.writeBigUInt64BE(BigInt(999999999), b.length - 24); // numObjects 轰炸
    expect(() => parseBplist(b)).toThrow();
  });

  it("单对象声明天文长度：先验界再分配，不给大分配 DoS 机会", () => {
    // 手搓：一个数组对象声明 0xffffff 个元素但字节根本不够
    const body = Buffer.from([0xaf, 0x12, 0x00, 0xff, 0xff, 0xff]);
    const table = Buffer.from([8]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1; trailer[7] = 1;
    trailer.writeBigUInt64BE(BigInt(1), 8);
    trailer.writeBigUInt64BE(BigInt(0), 16);
    trailer.writeBigUInt64BE(BigInt(14), 24);
    const buf = Buffer.concat([Buffer.from("bplist00", "latin1"), body, table, trailer]);
    expect(() => parseBplist(buf)).toThrow(/length out of range/);
  });

  it("16 字节整数（真 qlab 文件实测存在，UUID/哈希类）宽容解析不抛错", () => {
    const body = Buffer.concat([Buffer.from([0x14]), Buffer.alloc(16, 0xff)]);
    const table = Buffer.from([8]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1; trailer[7] = 1;
    trailer.writeBigUInt64BE(BigInt(1), 8);
    trailer.writeBigUInt64BE(BigInt(0), 16);
    trailer.writeBigUInt64BE(BigInt(25), 24);
    const buf = Buffer.concat([Buffer.from("bplist00", "latin1"), body, table, trailer]);
    expect(typeof parseBplist(buf).top).toBe("number"); // 值有损但解析继续
  });
});

// ─── zip 包内工程递归 ────────────────────────────────────────────────────────

/** 真 local header 的 zip 构造器（递归要按 offset 取 entry，假 offset 不行了）。 */
function realZip(files: { name: string; content: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let pos = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name, "utf8");
    const data = f.deflate ? deflateRawSync(f.content) : f.content;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(0x800, 6); // UTF-8 flag
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(f.content.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(Buffer.concat([lh, nameB, data]));
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(f.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(f.content.length, 24);
    cd.writeUInt16LE(nameB.length, 28);
    cd.writeUInt32LE(pos, 42);
    cds.push(Buffer.concat([cd, nameB]));
    pos += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(pos, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("zipParser v3：包内工程递归", () => {
  it("als entry 解压→递归分析→引用对 entry 表 join（NFD 命中 + 缺失计数）", async () => {
    const als = gzipSync(Buffer.from(ALS_XML));
    const zip = realZip([
      { name: "Proj/show.als", content: als, deflate: true },
      // entry 存 NFD（macOS zip 现实），引用是 NFC——路径匹配器负责对上；take1 缺失
      { name: "Proj/Samples/Recorded/take1.aif".normalize("NFD"), content: Buffer.from("x") },
    ]);
    const env = await extractEnvelope(bufferByteSource(zip), "交付.zip");
    expect(env.status).toBe("ok");
    const projects = env.data?.projects as Record<string, unknown>[];
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: "Proj/show.als", kind: "application/vnd.ableton.live-set",
      refCount: 1, missingCount: 0,
    });
    // v4：工程元数据本体随体检带出（只有 join 没有结构=半截子）
    expect(projects[0].meta).toMatchObject({ trackCount: 3, creator: "Ableton Live 12.3.5" });
    expect((projects[0].meta as Record<string, unknown>).tracks).toHaveLength(3);
  });

  it("缺引用如实上报 missing", async () => {
    const als = gzipSync(Buffer.from(ALS_XML));
    const zip = realZip([{ name: "Proj/show.als", content: als, deflate: true }]);
    const env = await extractEnvelope(bufferByteSource(zip), "缺样本.zip");
    const projects = env.data?.projects as Record<string, unknown>[];
    expect(projects[0]).toMatchObject({ refCount: 1, missingCount: 1 });
    expect(projects[0].missing).toEqual(["Samples/Recorded/take1.aif"]);
  });

  it("AppleDouble 垃圾（__MACOSX/._x.qlab5）不进工程扫描（线上「解析失败」占坑实测）", async () => {
    const als = gzipSync(Buffer.from(ALS_XML));
    const zip = realZip([
      { name: "__MACOSX/Proj/._show.als", content: Buffer.from("AppleDouble junk") },
      { name: "Proj/._backup.qlab5", content: Buffer.from("junk") },
      { name: "Proj/show.als", content: als, deflate: true },
    ]);
    const env = await extractEnvelope(bufferByteSource(zip), "mac交付.zip");
    const projects = env.data?.projects as Record<string, unknown>[];
    expect(projects).toHaveLength(1); // 只有真工程
    expect(projects[0].path).toBe("Proj/show.als");
  });

  it("损坏的工程 entry 只记错误行，不拖垮 zip 信封", async () => {
    const zip = realZip([{ name: "bad.als", content: Buffer.from("not gzip") }]);
    const env = await extractEnvelope(bufferByteSource(zip), "坏工程.zip");
    expect(env.status).toBe("ok");
    const projects = env.data?.projects as Record<string, unknown>[];
    expect(projects[0].error).toBeTruthy();
  });
});

describe("openZipEntrySource：包内单 entry 元数据（支持面≠独立支持面）", () => {
  const als = gzipSync(Buffer.from(ALS_XML));

  it("store entry 偏移直通：当独立文件走完整分析管线", async () => {
    const zip = realZip([{ name: "Proj/show.als", content: als }]); // method 0
    const zipSrc = bufferByteSource(zip);
    const listing = await extractEnvelope(zipSrc, "交付.zip");
    const e = (listing.data?.entries as Record<string, unknown>[])[0];
    const es = await openZipEntrySource(zipSrc, {
      offset: Number(e.offset), method: Number(e.method), compressedBytes: Number(e.compressedBytes),
      uncompressedBytes: e.uncompressedBytes as number,
    });
    const env = await extractEnvelope(es, "show.als");
    expect(env.status).toBe("ok");
    expect(env.detectedType).toBe("application/vnd.ableton.live-set");
    expect(env.data).toMatchObject({ trackCount: 3 });
  });

  it("deflate entry ≤上限整解压后照常分析", async () => {
    const zip = realZip([{ name: "show.als", content: als, deflate: true }]);
    const zipSrc = bufferByteSource(zip);
    const listing = await extractEnvelope(zipSrc, "交付.zip");
    const e = (listing.data?.entries as Record<string, unknown>[])[0];
    const es = await openZipEntrySource(zipSrc, {
      offset: Number(e.offset), method: Number(e.method), compressedBytes: Number(e.compressedBytes),
      uncompressedBytes: e.uncompressedBytes as number,
    });
    const env = await extractEnvelope(es, "show.als");
    expect(env.data).toMatchObject({ creator: "Ableton Live 12.3.5" });
  });

  it("deflate 超上限 / 加密 entry 确定性拒绝（媒体类巨物不解压）", async () => {
    const zip = realZip([{ name: "big.wav", content: als, deflate: true }]);
    const src = bufferByteSource(zip);
    await expect(openZipEntrySource(src, {
      offset: 0, method: 8, compressedBytes: ZIP_ENTRY_INFLATE_CAP + 1, uncompressedBytes: null,
    })).rejects.toThrow(/too large/);
    await expect(openZipEntrySource(src, {
      offset: 0, method: 8, compressedBytes: 10, uncompressedBytes: null, encrypted: true,
    })).rejects.toThrow(/encrypted/);
  });
});

it("PR3 批 bump 到 BROKER_VERSION 4", () => {
  expect(BROKER_VERSION).toBe(4);
});
